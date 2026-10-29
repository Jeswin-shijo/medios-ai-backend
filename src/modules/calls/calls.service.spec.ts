import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { clinicNow, isoDate, parseIsoDay, spokenDay } from '../../common/utils/clinic-time';
import { CallsService } from './calls.service';
import { InboundService } from './inbound.service';
import { SlotsService } from './slots.service';
import { StartCallRequest, VoiceProvider } from './providers/voice-provider';

// Made-up numbers only.
const LISTED = '+91 98765 43210';
const UNLISTED = '+91 98765 43299';

const dayOffset = (days: number) => {
  const d = clinicNow();
  d.setDate(d.getDate() + days);
  return isoDate(d);
};

/** Records every call it is asked to place; nothing rings. */
class FakeProvider implements VoiceProvider {
  readonly name = 'simulated';
  readonly live = false;
  started: StartCallRequest[] = [];
  async startCall(request: StartCallRequest) {
    this.started.push(request);
    return { providerCallId: `fake_${this.started.length}` };
  }
}

describe('CallsService', () => {
  const m = models();
  let service: CallsService;
  let provider: FakeProvider;
  let allowedNumbers: string[];

  const patient = (phone = LISTED) => m.Patient.create({ uhid: 'MHK202600201', name: 'Rekha Suresh', age: 34, gender: 'Female', phone });
  const queued = (over: Record<string, unknown> = {}) =>
    m.AgentCall.create({
      purpose: 'booking',
      status: 'scheduled',
      uhid: 'MHK202600201',
      patientName: 'Rekha Suresh',
      phone: '+919876543210',
      scheduledFor: new Date(Date.now() - 60_000),
      provider: 'simulated',
      visitReason: 'Thyroid review',
      ...over,
    });
  const reload = (id: unknown) => m.AgentCall.findById(id).lean().exec() as Promise<any>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    allowedNumbers = [];
    provider = new FakeProvider();
    const settings = new SettingsService(m.HospitalSettings);
    // Calls may go out at any hour the tests run.
    await settings.updateSettings({ callAgent: { callingHoursStart: '00:00', callingHoursEnd: '23:59' } } as any, { role: UserRole.ADMIN });
    const tasks = new TasksAlertsService(m.TaskAlertItem);
    const slots = new SlotsService(m.Appointment);
    const inbound = new InboundService(m.AgentCall, m.InboundSession, m.CallerLookup, m.Appointment, m.Patient, new AppointmentEvents(), tasks, settings, slots);
    const config = { get: (key: string) => (key === 'callAgent.allowedNumbers' ? allowedNumbers : undefined) };
    service = new CallsService(m.AgentCall, m.Appointment, m.Patient, m.FollowUpItem, tasks, settings, slots, inbound, config as any, provider);
  });

  describe('the test safety list (CALL_ALLOWED_NUMBERS)', () => {
    test('a call can only be requested to a listed number', async () => {
      allowedNumbers = ['098765 43210'];
      await patient(UNLISTED);
      await assert.rejects(() => service.requestBooking({ uhid: 'MHK202600201' }, 'Staff'), (err: unknown) => err instanceof ConflictException && /CALL_ALLOWED_NUMBERS/.test(err.message));
      assert.equal(provider.started.length, 0);

      await m.Patient.updateOne({ uhid: 'MHK202600201' }, { phone: LISTED }).exec();
      const call = await service.requestBooking({ uhid: 'MHK202600201' }, 'Staff');
      assert.equal(call.status, 'calling');
      assert.equal(provider.started.length, 1);
    });

    test('a queued call to a number not on the list is refused when it is dialled', async () => {
      await patient();
      const call = await queued({ phone: '+919876543299' });
      allowedNumbers = [LISTED];
      await service.runDue();
      const after = await reload(call._id);
      assert.equal(after.status, 'failed');
      assert.equal(after.error, 'Not on the test safety list');
      assert.equal(provider.started.length, 0);
    });

    test('a call queued under another provider is refused when it is dialled', async () => {
      await patient();
      const call = await queued({ provider: 'snapserve' });
      await service.runDue();
      const after = await reload(call._id);
      assert.equal(after.status, 'failed');
      assert.equal(after.error, 'Queued under another call provider');
      assert.equal(provider.started.length, 0);
    });

    test('a listed number on the current provider is dialled', async () => {
      await patient();
      allowedNumbers = [LISTED];
      const call = await queued();
      await service.runDue();
      assert.equal((await reload(call._id)).status, 'calling');
      assert.equal(provider.started.length, 1);
    });
  });

  test('a confirmation call says the appointment day and time as they are when it is dialled', async () => {
    await patient();
    const apt = await m.Appointment.create({ uhid: 'MHK202600201', patientName: 'Rekha Suresh', age: 34, gender: 'Female', phone: LISTED, date: dayOffset(3), time: '10:00 AM', status: 'Scheduled' });
    const call = await service.requestConfirmation(String(apt._id), 'Staff', 'manual', 1, new Date(Date.now() + 3_600_000));
    assert.equal(call.status, 'scheduled');
    // Moved meanwhile (by an inbound call or the front desk).
    await m.Appointment.updateOne({ _id: apt._id }, { date: dayOffset(5), time: '11:30 AM' }).exec();
    await m.AgentCall.updateOne({ _id: call._id }, { scheduledFor: new Date(Date.now() - 60_000) }).exec();
    await service.runDue();
    assert.equal(provider.started.length, 1);
    assert.equal(provider.started[0].variables.appointment_day, spokenDay(parseIsoDay(dayOffset(5))));
    assert.equal(provider.started[0].variables.appointment_time, '11:30 AM');
    assert.equal((await reload(call._id)).variables.appointment_time, '11:30 AM');
  });

  describe('booking calls answered with "call back later"', () => {
    const answered = async (attempt: number) => {
      await patient();
      const call = await queued({ status: 'calling', attempt, providerCallId: `fake_${attempt}` });
      const callbackAt = new Date(Date.now() + 86_400_000);
      await service.recordResult({ callId: String(call._id), outcome: 'callback', callbackAt, summary: 'Someone else answered.', transcript: [] });
      return call;
    };

    test('a callback counts as an attempt', async () => {
      await answered(1);
      const next = (await m.AgentCall.findOne({ status: 'scheduled' }).lean().exec()) as any;
      assert.ok(next, 'the call back is queued');
      assert.equal(next.attempt, 2);
      assert.equal(next.trigger, 'callback');
    });

    test('after the last attempt the front desk takes over', async () => {
      const call = await answered(3);
      assert.equal(await m.AgentCall.countDocuments({ status: 'scheduled' }), 0, 'no fourth call');
      assert.match((await reload(call._id)).actionTaken, /front desk/);
      assert.equal(await m.TaskAlertItem.countDocuments({ uhid: 'MHK202600201', title: /Rekha Suresh/ }), 1);
    });
  });
});
