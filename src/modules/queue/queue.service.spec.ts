import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents, AppointmentStatusChange } from '../appointments/appointment-events';
import { SettingsService } from '../settings/settings.service';
import { QueueEvents } from './queue-events';
import { QueueService } from './queue.service';

describe('QueueService tells the appointment events about status changes it makes', () => {
  const m = models();
  let queue: QueueService;
  let changes: AppointmentStatusChange[];
  let appointmentId: string;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    const appointmentEvents = new AppointmentEvents();
    queue = new QueueService(m.QueueToken, m.QueueSequence, m.Appointment, m.Patient, new SettingsService(m.HospitalSettings), new QueueEvents(), appointmentEvents);
    queue.onModuleInit();
    changes = [];
    appointmentEvents.statusChanges$.subscribe((c) => changes.push(c));
    const apt = await m.Appointment.create({ uhid: 'U1', patientName: 'Patient One', age: 40, gender: 'Male', date: queue.today(), time: '10:00 AM', status: 'Scheduled' });
    appointmentId = String(apt._id);
  });

  test('a queue check-in emits statusChanged Checked In, exactly once', async () => {
    await queue.issue({ appointmentId }, 'desk');
    await new Promise((r) => setTimeout(r, 50)); // lets the queue's own subscriber run: it must not sync again
    assert.deepEqual(changes, [{ id: appointmentId, status: 'Checked In' }]);
    assert.equal(((await m.Appointment.findById(appointmentId).lean()) as any).status, 'Checked In');
  });

  test('a repeat check-in changes nothing, so it emits nothing', async () => {
    await queue.issue({ appointmentId }, 'desk');
    await queue.issue({ appointmentId }, 'desk');
    assert.equal(changes.length, 1);
  });

  test('skip back to Checked In emits it', async () => {
    const { token } = await queue.issue({ appointmentId }, 'desk');
    const { called } = await queue.call('Room 101', 'doc');
    assert.equal(String(called!._id), String(token._id));
    await queue.skip(String(token._id));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(changes.map((c) => c.status), ['Checked In', 'In Consultation', 'Checked In']);
  });
});
