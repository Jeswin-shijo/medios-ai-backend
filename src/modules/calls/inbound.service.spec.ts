import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { TasksAlertsService } from '../tasks-alerts/tasks-alerts.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { clinicNow, displayDate, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { InboundService, ToolContext, ToolReply } from './inbound.service';
import { SlotsService } from './slots.service';
import { CallResult } from './providers/voice-provider';
import { toE164India } from './phone';

// Made-up numbers only.
const NUM = {
  rekha: '+91 98765 43210',
  arun: '98765 43211',
  family: '098765 43212',
  other: '+91 98765 43299',
};
const e164 = (n: string) => toE164India(n)!;
const ADMIN = { role: UserRole.ADMIN };

const ASK_DOB = "Ask the caller for the patient's date of birth, then try again.";
const NO_MATCH = 'Those details do not match our records.';
const SPELL = 'Ask the caller to spell the name in English letters';

const dayOffset = (days: number) => {
  const d = clinicNow();
  d.setDate(d.getDate() + days);
  return isoDate(d);
};

describe('InboundService', () => {
  const m = models();
  let inbound: InboundService;
  let settings: SettingsService;

  const patient = (uhid: string, name: string, phone: string, extra: Record<string, unknown> = {}) =>
    m.Patient.create({ uhid, name, age: 34, gender: 'Female', phone, ...extra });
  const appointment = (p: { uhid: string; name: string; phone: string }, days: number, time = '10:00 AM') =>
    m.Appointment.create({ uhid: p.uhid, patientName: p.name, age: 34, gender: 'Female', phone: p.phone, date: dayOffset(days), time, status: 'Scheduled' });
  const run = (tool: string, args: Record<string, unknown>, ctx: ToolContext = {}) => inbound.run(tool, args, ctx);
  const find = (args: Record<string, unknown>, ctx: ToolContext = {}) => run('find_patient', args, ctx);
  const failures = async (phone: string) => ((await m.CallerLookup.findOne({ phone: e164(phone) }).lean().exec()) as any)?.failures ?? 0;
  const rekha = () => patient('MHK202600101', 'Rekha Suresh', NUM.rekha, { dob: '14 Mar 1992' });
  const arun = () => patient('MHK202600102', 'Arun Kumar', NUM.arun, { gender: 'Male' });
  const REKHA = { phone: NUM.rekha, patient_name: 'Rekha Suresh', date_of_birth: '14 March 1992' };
  const STRONG: ToolContext = { callerNumber: NUM.rekha };

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    settings = new SettingsService(m.HospitalSettings);
    inbound = new InboundService(
      m.AgentCall,
      m.InboundSession,
      m.CallerLookup,
      m.Appointment,
      m.Patient,
      new AppointmentEvents(),
      new TasksAlertsService(m.TaskAlertItem),
      settings,
      new SlotsService(m.Appointment),
    );
  });

  // ---------------------------------------------------------------- find_patient

  describe('find_patient', () => {
    test('caller ID matches: full name and DOB verify; the code stays out of the message; the session lasts 20 minutes', async () => {
      const p = await rekha();
      await appointment(p, 3);
      const r = await find({ phone: '9876543210', patient_name: 'Rekha Suresh', date_of_birth: '14th March 1992' }, { ...STRONG, providerCallId: 'call-1' });
      assert.equal(r.ok, true);
      assert.equal(r.verified, true);
      assert.match(String(r.caller_ref), /^[A-Z2-9]{6}$/);
      assert.equal((r.appointments as unknown[]).length, 1);
      assert.equal(r.patient_first_name, 'Rekha');
      assert.ok(!String(r.message).includes(String(r.caller_ref)), 'the agent may read the message aloud');
      const session = (await m.InboundSession.findOne({ code: r.caller_ref }).lean().exec()) as any;
      const minutes = (session.expiresAt.getTime() - Date.now()) / 60_000;
      assert.ok(minutes > 19 && minutes <= 20, `session lasts ${minutes} minutes`);
    });

    test('caller ID matches and no DOB is on file: the full name is enough', async () => {
      await arun();
      const r = await find({ patient_name: 'Arun Kumar' }, { callerNumber: NUM.arun });
      assert.equal(r.verified, true);
      assert.equal(r.ok, true);
    });

    test('caller ID differs and a DOB is on file: the DOB verifies', async () => {
      await rekha();
      const r = await find(REKHA, { callerNumber: NUM.other });
      assert.equal(r.verified, true);
    });

    test('caller ID missing or different and no DOB on file: cannot verify on this line, offer a callback, not counted', async () => {
      await arun();
      const args = { phone: NUM.arun, patient_name: 'Arun Kumar', date_of_birth: '1 Jan 1986' };
      const different = await find(args, { callerNumber: NUM.other });
      const missing = await find(args);
      for (const r of [different, missing]) {
        assert.equal(r.ok, false);
        assert.equal(r.verified, false);
        assert.ok(String(r.message).startsWith(NO_MATCH), String(r.message));
        assert.match(String(r.message), /request_callback/);
      }
      assert.equal(await failures(NUM.arun), 0);
    });

    test('a missing or unreadable DOB gets one reply whether or not the name matched, and is not counted', async () => {
      await rekha();
      const weak = { callerNumber: NUM.other };
      const a = await find({ phone: NUM.rekha, patient_name: 'Rekha Suresh' }, weak);
      const b = await find({ phone: NUM.rekha, patient_name: 'Somebody Else' }, weak);
      const c = await find({ phone: NUM.rekha, patient_name: 'Rekha Suresh', date_of_birth: 'sometime in 92' }, weak);
      const d = await find({ patient_name: 'Rekha Suresh' }, STRONG);
      const e = await find({ patient_name: 'Somebody Else' }, STRONG);
      assert.equal(a.message, ASK_DOB);
      for (const r of [b, c, d, e]) assert.deepEqual(r, a);
      assert.equal(await failures(NUM.rekha), 0);
    });

    test('every mismatch gets the same generic message, never naming the detail', async () => {
      await rekha();
      const wrongName = await find({ ...REKHA, patient_name: 'Priya Suresh' }, STRONG);
      const wrongDob = await find({ ...REKHA, date_of_birth: '15 Mar 1992' }, STRONG);
      const nobody = await find({ ...REKHA, phone: '9876500000' }, { callerNumber: '9876500000' });
      for (const r of [wrongName, wrongDob, nobody]) {
        assert.equal(r.ok, false);
        assert.equal(r.message, wrongName.message);
        assert.ok(String(r.message).startsWith(NO_MATCH));
        assert.doesNotMatch(String(r.message), /several/i);
      }
      assert.equal(wrongName.attempts_left, 2);
      assert.equal(wrongDob.attempts_left, 1);
      assert.equal(nobody.attempts_left, 2);
    });

    test('a family number is narrowed by full name, then by DOB', async () => {
      const raj = await patient('MHK202600110', 'Kavya Raj', NUM.family);
      await patient('MHK202600111', 'Kavya Ravi', NUM.family);
      await patient('MHK202600112', 'Raja Kumar', NUM.family, { dob: '01 May 1960', gender: 'Male' });
      const son = await patient('MHK202600113', 'Raja Kumar', NUM.family, { dob: '01 Jun 1990', gender: 'Male' });
      const ctx = { callerNumber: NUM.family };

      const kavya = await find({ patient_name: 'Kavya Raj', date_of_birth: '3 Mar 2001' }, ctx);
      assert.equal(kavya.verified, true);
      assert.equal(((await m.InboundSession.findOne({ code: kavya.caller_ref }).lean().exec()) as any).uhid, raj.uhid);

      const raja = await find({ patient_name: 'Raja Kumar', date_of_birth: '01/06/1990' }, ctx);
      assert.equal(raja.verified, true);
      assert.equal(((await m.InboundSession.findOne({ code: raja.caller_ref }).lean().exec()) as any).uhid, son.uhid);
    });

    test('two patients still matching after name and DOB: ask for the DOB, not counted', async () => {
      await patient('MHK202600120', 'Anu Priya', NUM.family);
      await patient('MHK202600121', 'Anu Priya', NUM.family);
      const r = await find({ patient_name: 'Anu Priya', date_of_birth: '1 Jan 2010' }, { callerNumber: NUM.family });
      assert.equal(r.ok, false);
      assert.equal(r.message, ASK_DOB);
      assert.equal(await failures(NUM.family), 0);
    });

    test('three failures lock the number; a success in between does not reset the count', async () => {
      await rekha();
      const wrong = { ...REKHA, date_of_birth: '15 Mar 1992' };
      assert.equal((await find(wrong, STRONG)).attempts_left, 2);
      assert.equal((await find(REKHA, STRONG)).verified, true);
      assert.equal((await find(wrong, STRONG)).attempts_left, 1);
      const third = await find(wrong, STRONG);
      assert.equal(third.locked, true);
      assert.equal(third.ok, false);
      const after = await find(REKHA, STRONG);
      assert.equal(after.locked, true, 'locked even with the right details');
      assert.equal(await m.TaskAlertItem.countDocuments({ title: /^Inbound caller not verified/ }), 1);
    });

    test('the failure count lapses 30 minutes after the last failure', async () => {
      await rekha();
      const wrong = { ...REKHA, date_of_birth: '15 Mar 1992' };
      await find(wrong, STRONG);
      assert.equal((await find(wrong, STRONG)).attempts_left, 1);
      const lookup = (await m.CallerLookup.findOne({ phone: e164(NUM.rekha) }).lean().exec()) as any;
      const minutes = (lookup.failuresUntil.getTime() - Date.now()) / 60_000;
      assert.ok(minutes > 29 && minutes <= 30);
      await m.CallerLookup.updateOne({ phone: e164(NUM.rekha) }, { $set: { failuresUntil: new Date(Date.now() - 1000) } }).exec();
      const r = await find(wrong, STRONG);
      assert.equal(r.attempts_left, 2);
      assert.notEqual(r.locked, true);
    });

    const lockOnce = async () => {
      const wrong = { ...REKHA, date_of_birth: '15 Mar 1992' };
      for (let i = 0; i < 3; i++) await find(wrong, STRONG);
      const lookup = (await m.CallerLookup.findOne({ phone: e164(NUM.rekha) }).lean().exec()) as any;
      return Math.round((lookup.lockedUntil.getTime() - Date.now()) / 60_000);
    };
    const unlock = () =>
      m.CallerLookup.updateOne({ phone: e164(NUM.rekha) }, { $set: { lockedUntil: new Date(Date.now() - 1000), failuresUntil: new Date(Date.now() - 1000) } }).exec();

    test('locks grow within 24 hours (30 minutes, 2 hours, 24 hours) with an admin alert from the second', async () => {
      await rekha();
      assert.equal(await lockOnce(), 30);
      assert.equal(await m.TaskAlertItem.countDocuments({ title: /^Repeated failed caller checks/ }), 0);
      await unlock();
      assert.equal(await lockOnce(), 120);
      await unlock();
      assert.equal(await lockOnce(), 24 * 60);
      const alerts = await m.TaskAlertItem.find({ title: /^Repeated failed caller checks/ }).lean().exec();
      assert.equal(alerts.length, 2);
      for (const a of alerts as any[]) {
        assert.equal(a.title, 'Repeated failed caller checks from …3210');
        assert.equal(a.priority, 'High');
        const text = `${a.title} ${a.subtitle} ${a.patientName}`;
        assert.ok(!text.includes('9876543210') && !text.includes('98765 43210'), 'never the full number');
        assert.ok(!/rekha/i.test(text), 'never a name');
      }
    });

    test('a lock count older than 24 hours starts again', async () => {
      await rekha();
      assert.equal(await lockOnce(), 30);
      await unlock();
      await m.CallerLookup.updateOne({ phone: e164(NUM.rekha) }, { $set: { locksUntil: new Date(Date.now() - 1000) } }).exec();
      assert.equal(await lockOnce(), 30);
      assert.equal(await m.TaskAlertItem.countDocuments({ title: /^Repeated failed caller checks/ }), 0);
    });

    test('a name in another script asks for English letters and is not counted', async () => {
      await rekha();
      const r = await find({ ...REKHA, patient_name: 'ரேகா சுரேஷ்' }, STRONG);
      assert.equal(r.ok, false);
      assert.ok(String(r.message).startsWith(SPELL), String(r.message));
      assert.equal(await failures(NUM.rekha), 0);
    });

    test('a DOB on file that cannot be read counts as no DOB', async () => {
      await patient('MHK202600130', 'Latha Devi', NUM.arun, { dob: 'sometime in 92' });
      assert.equal((await find({ patient_name: 'Latha Devi' }, { callerNumber: NUM.arun })).verified, true);
      const weak = await find({ phone: NUM.arun, patient_name: 'Latha Devi', date_of_birth: '1 Jan 1992' }, { callerNumber: NUM.other });
      assert.ok(String(weak.message).startsWith(NO_MATCH));
      assert.equal(await failures(NUM.arun), 0);
    });
  });

  // ---------------------------------------------------------------- sessions

  describe('sessions', () => {
    test("another call's caller_ref is refused; the session is bound to its call", async () => {
      await rekha();
      const r = await find(REKHA, { ...STRONG, providerCallId: 'call-1' });
      const ref = { caller_ref: r.caller_ref };
      assert.equal((await run('list_appointments', ref, { providerCallId: 'call-2', callerNumber: NUM.rekha })).ok, false);
      assert.equal((await run('list_appointments', ref)).ok, false, 'no call id at all');
      assert.equal((await run('list_appointments', ref, { providerCallId: 'call-1' })).ok, true);
      assert.equal((await run('list_appointments', { caller_ref: 'ZZZZZZ' }, { providerCallId: 'call-1' })).ok, false);
    });

    test('a session opened without a call id is bound to the caller number, then to the first call id', async () => {
      await rekha();
      const r = await find(REKHA, STRONG);
      const ref = { caller_ref: r.caller_ref };
      assert.equal((await run('list_appointments', ref, { callerNumber: NUM.other })).ok, false);
      assert.equal((await run('list_appointments', ref, { callerNumber: NUM.rekha, providerCallId: 'call-7' })).ok, true);
      assert.equal((await run('list_appointments', ref, { callerNumber: NUM.rekha, providerCallId: 'call-8' })).ok, false);
    });

    test("appointment codes only reach the session's own patient", async () => {
      const p = await rekha();
      const other = await arun();
      await appointment(p, 3);
      const theirs = await appointment(other, 4);
      const r = await find(REKHA, STRONG);
      await m.InboundSession.updateOne({ code: r.caller_ref }, { $set: { 'appointments.0.appointmentId': String(theirs._id) } }).exec();
      const out = await run('cancel_appointment', { caller_ref: r.caller_ref, appointment_id: 'A1' }, STRONG);
      assert.equal(out.ok, false);
      assert.equal(((await m.Appointment.findById(theirs._id).lean().exec()) as any).status, 'Scheduled');
    });

    test('an expired session is refused', async () => {
      await rekha();
      const r = await find(REKHA, STRONG);
      await m.InboundSession.updateOne({ code: r.caller_ref }, { $set: { expiresAt: new Date(Date.now() - 1000) } }).exec();
      const out = await run('list_appointments', { caller_ref: r.caller_ref }, STRONG);
      assert.equal(out.ok, false);
      assert.match(String(out.message), /Verify the caller first/);
    });
  });

  // ---------------------------------------------------------------- changes

  describe('changes', () => {
    const verified = async (ctx: ToolContext = STRONG) => {
      const r = await find(REKHA, ctx);
      assert.equal(r.verified, true);
      return String(r.caller_ref);
    };
    const session = (code: string) => m.InboundSession.findOne({ code }).lean().exec() as Promise<any>;

    test('with changes by phone off, a change is refused and the front desk gets a task', async () => {
      const p = await rekha();
      await settings.updateSettings({ callAgent: { inboundChanges: false } } as any, ADMIN);
      const ref = await verified();
      assert.equal((await run('find_free_slots', { caller_ref: ref }, STRONG)).ok, true);
      const out = await run('book_appointment', { caller_ref: ref, slot_id: 'S1' }, STRONG);
      assert.equal(out.ok, false);
      assert.match(String(out.message), /front desk/);
      assert.equal(await m.Appointment.countDocuments({ uhid: p.uhid }), 0);
      assert.equal(await m.TaskAlertItem.countDocuments({ title: /asked to book an appointment by phone/ }), 1);
    });

    test('a slot taken meanwhile is refused', async () => {
      await rekha();
      const other = await arun();
      const ref = await verified();
      await run('find_free_slots', { caller_ref: ref }, STRONG);
      const slot = (await session(ref)).slots[0];
      await m.Appointment.create({ uhid: other.uhid, patientName: other.name, age: 40, gender: 'Male', date: slot.date, time: slot.time, status: 'Scheduled' });
      const out = await run('book_appointment', { caller_ref: ref, slot_id: 'S1' }, STRONG);
      assert.equal(out.ok, false);
      assert.match(String(out.message), /just taken/);
    });

    test('book and reschedule keep nextAppointment on the earliest upcoming visit', async () => {
      const p = await rekha();
      await appointment(p, 2, '10:00 AM');
      const ref = await verified();
      const label = (iso: string, time: string) => `${displayDate(parseIsoDay(iso))} ${time}`;
      const next = async () => ((await m.Patient.findOne({ uhid: p.uhid }).lean().exec()) as any).nextAppointment;

      await run('find_free_slots', { caller_ref: ref, preferred_date: dayOffset(5) }, STRONG);
      const booked = (await session(ref)).slots[0];
      assert.equal((await run('book_appointment', { caller_ref: ref, slot_id: 'S1' }, STRONG)).ok, true);
      assert.equal(await next(), label(dayOffset(2), '10:00 AM'), 'the earlier visit stays next');

      await run('list_appointments', { caller_ref: ref }, STRONG);
      await run('find_free_slots', { caller_ref: ref, preferred_date: dayOffset(8) }, STRONG);
      assert.equal((await run('reschedule_appointment', { caller_ref: ref, appointment_id: 'A1', slot_id: 'S1' }, STRONG)).ok, true);
      assert.equal(await next(), label(booked.date, booked.time), 'the booked visit is now next');
    });

    test('an inbound cancel raises the same front-desk alert as an outbound one', async () => {
      const p = await rekha();
      await appointment(p, 3);
      const ref = await verified();
      const out = await run('cancel_appointment', { caller_ref: ref, appointment_id: 'A1', reason: 'travelling' }, STRONG);
      assert.equal(out.ok, true);
      const task = (await m.TaskAlertItem.findOne({ title: 'Appointment cancelled by Rekha Suresh' }).lean().exec()) as any;
      assert.ok(task, 'front-desk alert');
      assert.equal(task.priority, 'Low');
      assert.match(task.subtitle, /slot is free again/);
    });

    test('an appointment whose time has passed cannot be changed', async () => {
      const p = await rekha();
      const apt = await appointment(p, 1);
      const ref = await verified();
      await m.Appointment.updateOne({ _id: apt._id }, { $set: { date: dayOffset(-1) } }).exec();
      assert.equal((await run('cancel_appointment', { caller_ref: ref, appointment_id: 'A1' }, STRONG)).ok, false);
      assert.equal((await run('confirm_appointment', { caller_ref: ref, appointment_id: 'A1' }, STRONG)).ok, false);
      assert.equal(((await m.Appointment.findById(apt._id).lean().exec()) as any).status, 'Scheduled');
    });

    test('a preferred_date more than 90 days ahead is refused', async () => {
      await rekha();
      const ref = await verified();
      const far = await run('find_free_slots', { caller_ref: ref, preferred_date: dayOffset(100) }, STRONG);
      assert.equal(far.ok, false);
      assert.match(String(far.message), /90 days/);
      assert.equal((await run('find_free_slots', { caller_ref: ref, preferred_date: dayOffset(80) }, STRONG)).ok, true);
    });
  });

  // ---------------------------------------------------------------- the call log

  describe('recordCall', () => {
    const result = (over: Partial<CallResult>): CallResult => ({
      outcome: 'enquiry',
      summary: 'Caller asked about their visit.',
      transcript: [],
      endedAt: new Date(),
      direction: 'inbound',
      fromNumber: NUM.rekha,
      ...over,
    });
    const log = (providerCallId: string) => m.AgentCall.findOne({ providerCallId }).lean().exec() as Promise<any>;
    const urgentAlerts = () => m.TaskAlertItem.countDocuments({ priority: 'High', title: /^Call back urgently/ });
    const bookOne = async (ctx: ToolContext) => {
      const r = await find(REKHA, ctx);
      await run('find_free_slots', { caller_ref: r.caller_ref }, ctx);
      const out: ToolReply = await run('book_appointment', { caller_ref: r.caller_ref, slot_id: 'S1' }, ctx);
      assert.equal(out.ok, true);
      return String(r.caller_ref);
    };

    test("the provider's Needs staff wins over a booking and raises the urgent backup alert", async () => {
      await rekha();
      await bookOne({ ...STRONG, providerCallId: 'c1' });
      await inbound.recordCall(result({ providerCallId: 'c1', outcome: 'escalated', durationSec: 120 }), 'snapserve');
      const row = await log('c1');
      assert.equal(row.outcome, 'escalated');
      assert.equal(row.uhid, 'MHK202600101');
      assert.match(row.actionTaken, /Booked/);
      assert.match(row.actionTaken, /Care team alerted/);
      assert.equal(await urgentAlerts(), 1);
    });

    test('no backup alert after an urgent request_callback; a routine callback does not count', async () => {
      await rekha();
      await arun();
      const a = await find(REKHA, { ...STRONG, providerCallId: 'c2' });
      await run('request_callback', { caller_ref: a.caller_ref, reason: 'Chest pain since morning', urgent: true }, { ...STRONG, providerCallId: 'c2' });
      assert.equal(((await m.InboundSession.findOne({ code: a.caller_ref }).lean().exec()) as any).urgent, true);
      assert.equal(await urgentAlerts(), 1);
      await inbound.recordCall(result({ providerCallId: 'c2', outcome: 'escalated' }), 'snapserve');
      assert.equal(await urgentAlerts(), 1, 'no second alert');

      const ctx = { callerNumber: NUM.arun, providerCallId: 'c3' };
      const b = await find({ patient_name: 'Arun Kumar' }, ctx);
      await run('request_callback', { caller_ref: b.caller_ref, reason: 'A question about fees' }, ctx);
      await inbound.recordCall(result({ providerCallId: 'c3', outcome: 'escalated', fromNumber: NUM.arun }), 'snapserve');
      assert.equal(await urgentAlerts(), 2, 'a routine callback is no urgent one');
    });

    test('wrong number and not verified win over the session; otherwise the session decides', async () => {
      await rekha();
      await bookOne({ ...STRONG, providerCallId: 'c4' });
      await inbound.recordCall(result({ providerCallId: 'c4', outcome: 'unverified' }), 'snapserve');
      assert.equal((await log('c4')).outcome, 'unverified');
      assert.match((await log('c4')).actionTaken, /Booked/);

      await bookOne({ ...STRONG, providerCallId: 'c5' });
      await inbound.recordCall(result({ providerCallId: 'c5', outcome: 'enquiry' }), 'snapserve');
      assert.equal((await log('c5')).outcome, 'booked');

      await inbound.recordCall(result({ providerCallId: 'c6', outcome: 'failed', unrecognised: 'Something odd', fromNumber: NUM.other }), 'snapserve');
      assert.equal((await log('c6')).outcome, 'enquiry');
    });

    test('a logged session is ended; the fallback skips other calls, logged sessions and sessions outside the call', async () => {
      await rekha();
      const ref = await bookOne({ ...STRONG, providerCallId: 'c1' });
      await inbound.recordCall(result({ providerCallId: 'c1', outcome: 'booked', durationSec: 90 }), 'snapserve');
      const ended = (await m.InboundSession.findOne({ code: ref }).lean().exec()) as any;
      assert.ok(ended.loggedAt);
      assert.ok(ended.expiresAt.getTime() <= Date.now());
      assert.equal((await run('list_appointments', { caller_ref: ref }, { ...STRONG, providerCallId: 'c1' })).ok, false);

      // A later call from the same number never reached find_patient.
      await inbound.recordCall(result({ providerCallId: 'c2', outcome: 'enquiry', durationSec: 60 }), 'snapserve');
      assert.equal((await log('c2')).patientName, 'Unverified caller');
      assert.equal((await log('c2')).uhid, '');

      // A live session of another call is not this call's.
      await find(REKHA, { ...STRONG, providerCallId: 'c9' });
      await inbound.recordCall(result({ providerCallId: 'c10', outcome: 'enquiry', durationSec: 60 }), 'snapserve');
      assert.equal((await log('c10')).uhid, '');

      // A session without a call id counts only when it began during the call.
      await m.InboundSession.deleteMany({}).exec();
      const old = await find(REKHA, STRONG);
      await m.InboundSession.collection.updateOne({ code: old.caller_ref }, { $set: { createdAt: new Date(Date.now() - 3_600_000) } });
      await inbound.recordCall(result({ providerCallId: 'c11', outcome: 'enquiry', durationSec: 60 }), 'snapserve');
      assert.equal((await log('c11')).uhid, '');
      await find(REKHA, STRONG);
      await inbound.recordCall(result({ providerCallId: 'c12', outcome: 'enquiry', durationSec: 120 }), 'snapserve');
      assert.equal((await log('c12')).uhid, 'MHK202600101');
    });

    test('a result delivered twice, even at the same moment, is logged once with one alert', async () => {
      await rekha();
      await find(REKHA, { ...STRONG, providerCallId: 'c20' });
      const outs = await Promise.all([
        inbound.recordCall(result({ providerCallId: 'c20', outcome: 'escalated' }), 'snapserve'),
        inbound.recordCall(result({ providerCallId: 'c20', outcome: 'escalated' }), 'snapserve'),
      ]);
      assert.equal(await m.AgentCall.countDocuments({ providerCallId: 'c20' }), 1);
      assert.equal(outs.filter((o) => o.duplicate).length, 1);
      assert.equal(await urgentAlerts(), 1);
      assert.equal((await inbound.recordCall(result({ providerCallId: 'c20', outcome: 'escalated' }), 'snapserve')).duplicate, true);
      assert.equal(await m.AgentCall.countDocuments({ providerCallId: 'c20' }), 1);
    });
  });
});
