import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { parseIsoDay } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { PatientsService } from '../patients/patients.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { SchedulingCoordinatorRegistration } from './scheduling-coordinator.registration';
import { SchedulingProceduresService } from './scheduling-procedures.service';
import { SchedulingSettingsService } from './scheduling-settings.service';

const DOC = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
const NURSE = { id: 'user-nurse', name: 'Nurse Priya', role: UserRole.NURSE };
const ADMIN = { id: 'user-admin', name: 'Admin', role: UserRole.ADMIN };
const MIN = 60_000;
/** Tuesday 20 Oct 2026, 07:00 local; CLINIC_DATE unset, so the clinic clock is this clock. */
const NOW = () => new Date(2026, 9, 20, 7, 0, 0, 0);
const D = '2026-10-20';
const D1 = '2026-10-21';
const at = (day: string, hhmm: string) => {
  const d = parseIsoDay(day);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};
const ms = (v: unknown) => new Date(v as string).getTime();

describe('SchedulingProceduresService', () => {
  const m = models();
  let savedClinic: string | undefined;
  let cases: CasesService;
  let procedures: SchedulingProceduresService;
  let settings: SchedulingSettingsService;
  let patientId: string;
  let patientUhid: string;
  let arun: any;
  let anitha: any;
  let ravi: any;

  const staff = (name: string, skills: string[], login = true) =>
    m.StaffMember.create({ name, skills, departmentCode: 'CARD', ...(login ? { userId: String(new Types.ObjectId()) } : {}) });
  const roster = (s: any, date = D, shift = 'morning') => m.RosterEntry.create({ date, shift, staff: s._id });
  /** A cardiologist, cath nurse and technician; rostered on the morning of D unless `rostered` says otherwise. */
  const cathTeam = async (opts: { nurseLogin?: boolean; rostered?: boolean; date?: string } = {}) => {
    arun = await staff('Dr. Arun', ['cardiologist']);
    anitha = await staff('Anitha', ['cath-nurse'], opts.nurseLogin ?? true);
    ravi = await staff('Ravi', ['cath-technician']);
    if (opts.rostered !== false) for (const s of [arun, anitha, ravi]) await roster(s, opts.date ?? D);
  };
  const ask = (priority: 'stat' | 'urgent' | 'routine' = 'routine', procedure = 'coronary-angiography', extra: Record<string, unknown> = {}) =>
    procedures.request(DOC, { patientId, procedure, priority, ...extra } as any);
  const sent = (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>;
  const alert = (link: string) => m.TaskAlertItem.findOne({ link }).lean().exec() as Promise<any>;

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    mock.timers.enable({ apis: ['Date'], now: NOW() });
    await resetTestDb();
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    new SchedulingCoordinatorRegistration(registry, m.ConsultRequest, m.ProcedureBooking, m.Clock).onModuleInit();
    settings = new SchedulingSettingsService(new SettingsService(m.HospitalSettings));
    procedures = new SchedulingProceduresService(
      m.ProcedureBooking, m.RoomBlock, m.StaffMember, m.RosterEntry, m.Appointment, m.OpDoctor, m.SchedulingLock,
      m.CoordinatorCounter, m.TaskAlertItem, new PatientsService(m.Patient), cases, messages, settings,
    );
    const p = await m.Patient.create({ uhid: 'MHK202600950', name: 'Mohan Raj', age: 58, gender: 'Male', phone: '9100000050' });
    patientId = String(p._id);
    patientUhid = p.uhid;
  });
  afterEach(() => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  test('a request books, assigns the team, sends procedure-booked with contrast, and raises a team notice', async () => {
    await cathTeam();
    const er = await cases.openOrJoin({ patientId, patientUhid, patientName: 'Mohan Raj', kind: 'er', priority: 'high', openedBy: 'er' });

    const v = await ask('routine', 'coronary-angiography', { note: 'Pressure in the chest' });
    assert.equal(v.number, 'PR-0001');
    assert.equal(v.status, 'booked');
    assert.equal(v.room, 'cath-lab');
    assert.equal(ms(v.start), at(D, '08:00').getTime(), '07:00 + 30 min, then the cath lab opens at 08:00');
    assert.equal(ms(v.end), at(D, '08:45').getTime());
    assert.deepEqual(
      v.team.map((t: any) => [t.role, t.staffId, t.name]),
      [['cardiologist', String(arun._id), 'Dr. Arun'], ['cath-nurse', String(anitha._id), 'Anitha'], ['cath-technician', String(ravi._id), 'Ravi']],
    );
    // It joins the open ER case rather than opening an OPD one.
    assert.equal(v.caseId, String(er.case._id));
    const theCase = await m.Case.findById(er.case._id).lean();
    assert.equal(theCase!.kind, 'er');
    assert.ok(theCase!.agents.includes('scheduling'));

    const [requested] = await sent('scheduling.procedure-requested');
    assert.deepEqual(requested.payload, { bookingId: v.id, number: 'PR-0001', procedure: 'coronary-angiography', priority: 'routine', status: 'requested' });
    assert.equal(requested.summary, 'PR-0001: Coronary angiography requested (ROUTINE)');
    const booked = await sent('scheduling.procedure-booked');
    assert.equal(booked.length, 1);
    const b = booked[0];
    assert.deepEqual(Object.keys(b.payload).sort(), ['bookingId', 'contrast', 'number', 'priority', 'procedure', 'room', 'start', 'status']);
    assert.deepEqual([b.payload.bookingId, b.payload.number, b.payload.procedure, b.payload.priority, b.payload.status, b.payload.room, b.payload.contrast],
      [v.id, 'PR-0001', 'coronary-angiography', 'routine', 'booked', 'cath-lab', true]);
    assert.equal(ms(b.payload.start), at(D, '08:00').getTime());
    assert.deepEqual(b.to, ['coordinator', 'lab', 'pharmacy']);
    assert.equal(b.priority, 'low');
    assert.equal(String(b.case), String(er.case._id));
    assert.match(b.summary, /^PR-0001: Coronary angiography booked .*\(ROUTINE\)$/);
    for (const msg of [requested, b]) assert.ok(!JSON.stringify(msg).includes('Mohan'), 'no patient name in a message');
    assert.ok((await m.ProcedureBooking.findById(v.id).lean())!.announcedAt, 'the booked message is marked sent');

    // Each member with a login gets a team notice.
    for (const [s, label] of [[arun, 'Cardiologist'], [anitha, 'Cath nurse'], [ravi, 'Cath technician']] as const) {
      const a = await alert(`scheduling-team:${v.id}:${s._id}`);
      assert.ok(a, `${s.name} has a notice`);
      assert.deepEqual([a.type, a.category, a.priority, a.status, a.uhid], ['System', 'System', 'Medium', 'Pending', patientUhid]);
      assert.ok(a.subtitle.startsWith(`For ${s.name} (${label})`), a.subtitle);
      assert.match(a.title, /Coronary angiography PR-0001 at 08:00 AM, Cath lab/);
    }

    // The next one keeps the cath lab's 15-minute turnover; the admin's minutes are used.
    assert.equal(ms((await ask()).start), at(D, '09:00').getTime());
    await settings.save(ADMIN, { procedureMinutes: { 'coronary-angiography': 60 } });
    const third = await ask();
    assert.deepEqual([ms(third.start), ms(third.end)], [at(D, '10:00').getTime(), at(D, '11:00').getTime()]);
  });

  test('a member without a login is announced to OT and cath lab in charge', async () => {
    await cathTeam({ nurseLogin: false });
    const v = await ask();
    const call = await alert(`scheduling-call:${v.id}:${anitha._id}`);
    assert.ok(call, 'a call notice for Anitha');
    assert.equal(call.title, 'Call Anitha (cath nurse): Coronary angiography PR-0001 at 08:00 AM, Cath lab');
    assert.ok(call.subtitle.startsWith('For OT and cath lab in charge'), call.subtitle);
    assert.deepEqual([call.type, call.category, call.priority, call.status], ['System', 'System', 'Medium', 'Pending']);
    assert.equal(await alert(`scheduling-team:${v.id}:${anitha._id}`), null, 'nobody to notify directly');
    assert.equal(await m.TaskAlertItem.countDocuments({ link: new RegExp(`^scheduling-team:${v.id}:`) }), 2);

    // Imaging falls back to the Duty administrator; a later day is named.
    const suresh = await staff('Suresh', ['radiographer'], false);
    await roster(suresh, D1);
    const x = await ask('routine', 'chest-xray');
    assert.equal(ms(x.start), at(D1, '08:00').getTime());
    const xc = await alert(`scheduling-call:${x.id}:${suresh._id}`);
    assert.equal(xc.title, 'Call Suresh (radiographer): Chest X-ray PR-0002 at 08:00 AM on 21 Oct 2026, X-ray');
    assert.ok(xc.subtitle.startsWith('For Duty administrator'), xc.subtitle);
  });

  test("can't book → status cant-book, one scheduling-wait alert, a booking clock; a roster change and retryWaiting book it and stop the clock", async () => {
    await cathTeam({ rostered: false });
    await roster(arun);
    await roster(anitha); // no technician on duty

    const v = await ask('urgent');
    assert.equal(v.status, 'cant-book');
    assert.equal(v.start, null);
    const wait = await m.TaskAlertItem.find({ link: `scheduling-wait:${v.id}` }).lean();
    assert.equal(wait.length, 1);
    assert.deepEqual([wait[0].type, wait[0].category, wait[0].priority, wait[0].status], ['System', 'System', 'High', 'Pending']);
    assert.match(wait[0].title, /^Can't book yet: Coronary angiography/);
    assert.ok(wait[0].subtitle.startsWith('For Dr. Shajin · PR-0001'), wait[0].subtitle);
    const cant = await sent('scheduling.procedure-cant-book');
    assert.equal(cant.length, 1);
    assert.equal(ms(cant[0].payload.dueAt), NOW().getTime() + 120 * MIN, 'urgent waits 120 min (real time)');
    assert.equal(cant[0].payload.status, 'cant-book');
    assert.equal(cant[0].summary, "PR-0001: Coronary angiography can't be booked yet (URGENT)");
    let clocks = await m.Clock.find({ def: 'scheduling-booking' }).lean();
    assert.deepEqual(clocks.map((c) => [c.ref, c.state, c.dueAt.getTime()]), [[v.id, 'running', NOW().getTime() + 120 * MIN]]);

    // Retrying with nothing changed changes nothing.
    assert.equal(await procedures.retryWaiting(), 0);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `scheduling-wait:${v.id}` }), 1);
    assert.equal((await sent('scheduling.procedure-cant-book')).length, 1);
    assert.equal(await m.Clock.countDocuments({ def: 'scheduling-booking' }), 1);

    await roster(ravi);
    assert.equal(await procedures.retryWaiting(), 1);
    const now = await procedures.get(v.id);
    assert.equal(now.status, 'booked');
    assert.equal(ms(now.start), at(D, '08:00').getTime());
    clocks = await m.Clock.find({ def: 'scheduling-booking' }).lean();
    assert.deepEqual(clocks.map((c) => c.state), ['met']);
    assert.equal((await alert(`scheduling-wait:${v.id}`)).status, 'Completed');
    assert.equal((await sent('scheduling.procedure-booked')).length, 1);

    // STAT waits on its own 15-minute target; routine waits without a clock.
    const stat = await ask('stat', 'upper-gi-endoscopy');
    const routine = await ask('routine', 'ct-head');
    assert.deepEqual([stat.status, routine.status], ['cant-book', 'cant-book']);
    const dues = new Map((await sent('scheduling.procedure-cant-book')).map((msg) => [msg.payload.bookingId, ms(msg.payload.dueAt)]));
    assert.equal(dues.get(stat.id), NOW().getTime() + 15 * MIN);
    assert.equal(dues.get(routine.id), NOW().getTime() + 20160 * MIN, 'routine: the end of its 14-day window');
    assert.equal(await m.Clock.countDocuments({ def: 'scheduling-booking', ref: stat.id, state: 'running' }), 1);
    assert.equal(await m.Clock.countDocuments({ def: 'scheduling-booking', ref: routine.id }), 0);
  });

  test('start, done and cancel send their messages; cancel frees the room', async () => {
    await cathTeam();
    const a = await ask();
    const b = await ask();
    assert.equal(ms(b.start), at(D, '09:00').getTime());

    const started = await procedures.start(NURSE, a.id);
    assert.equal(started.status, 'in-progress');
    assert.ok(started.startedAt);
    const cancelled = await procedures.cancel(DOC, b.id, 'Patient declined');
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual([cancelled.cancelled!.by, cancelled.cancelled!.reason], ['Dr. Shajin', 'Patient declined']);
    // The cancelled 09:00 slot is free again; the case in progress still holds 08:00 and its turnover.
    const c = await ask();
    assert.equal(ms(c.start), at(D, '09:00').getTime());
    const done = await procedures.done(DOC, a.id, 'No complications');
    assert.equal(done.status, 'done');
    assert.ok(done.doneAt);
    assert.match(done.history.at(-1)!.what, /No complications/);

    const payload = async (type: string) => (await sent(type)).map((msg) => [msg.payload.bookingId, msg.payload.status, msg.to.join(',')]);
    assert.deepEqual(await payload('scheduling.procedure-started'), [[a.id, 'in-progress', 'coordinator']]);
    assert.deepEqual(await payload('scheduling.procedure-done'), [[a.id, 'done', 'coordinator,lab,pharmacy']]);
    assert.deepEqual(await payload('scheduling.procedure-cancelled'), [[b.id, 'cancelled', 'coordinator,lab,pharmacy']]);
    assert.equal((await sent('scheduling.procedure-cancelled'))[0].summary, 'PR-0002: Coronary angiography cancelled (ROUTINE)');
    // The finished and the cancelled procedures' notices are closed.
    for (const id of [a.id, b.id]) {
      const notices = await m.TaskAlertItem.find({ link: new RegExp(`^scheduling-team:${id}:`) }).lean();
      assert.equal(notices.length, 3);
      assert.ok(notices.every((n) => n.status === 'Completed'));
    }

    await assert.rejects(procedures.start(DOC, b.id), BadRequestException, 'a cancelled procedure cannot start');
    await assert.rejects(procedures.done(DOC, c.id), BadRequestException, 'only a started procedure is done');
    await assert.rejects(procedures.cancel(DOC, c.id, '  '), BadRequestException, 'a reason is needed');
    await assert.rejects(procedures.cancel(DOC, a.id, 'Changed mind'), BadRequestException, 'a done procedure cannot be cancelled');
    await assert.rejects(procedures.start(DOC, String(new Types.ObjectId())), NotFoundException);
  });

  test('no start before clinic now + 30 min on the pinned day (the service plans on clinicNow)', async () => {
    process.env.CLINIC_DATE = '2026-09-26';
    mock.timers.reset();
    // The real date is weeks after the pinned clinic day.
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 1, 10, 7, 0, 0) });
    await cathTeam({ date: '2026-09-26' });
    const v = await ask();
    assert.equal(v.status, 'booked', 'the team is rostered on the pinned day, not the real one');
    assert.equal(ms(v.start), new Date(2026, 8, 26, 10, 45).getTime(), '10:07 + 30 min, then the next 15-minute mark');
    assert.equal(ms(v.earliest), new Date(2026, 8, 26, 10, 7).getTime(), 'earliest defaults to clinic now');
  });

  test('the lock: a held lock leaves a request waiting, an expired one is taken over, and two bookings at once never share the room', async () => {
    await cathTeam();
    await m.SchedulingLock.create({ key: 'procedures', until: new Date(Date.now() + 30_000) });
    const a = await ask();
    const b = await ask();
    assert.deepEqual([a.status, b.status], ['requested', 'requested']);
    assert.equal((await sent('scheduling.procedure-requested')).length, 2);
    assert.equal((await sent('scheduling.procedure-booked')).length, 0);

    await m.SchedulingLock.deleteMany({});
    assert.equal(await procedures.retryWaiting(), 0, 'a request younger than 30 s is left to its own call');
    const outcomes = await Promise.all([procedures.tryBook(a.id), procedures.tryBook(b.id)]);
    for (const [i, o] of outcomes.entries()) if (o === 'busy') assert.equal(await procedures.tryBook([a.id, b.id][i]), 'booked');
    const [ra, rb] = await Promise.all([procedures.get(a.id), procedures.get(b.id)]);
    assert.deepEqual([ra.status, rb.status, ra.room, rb.room], ['booked', 'booked', 'cath-lab', 'cath-lab']);
    assert.ok(Math.abs(ms(ra.start) - ms(rb.start)) >= 60 * MIN, '45 min plus 15 min turnover apart');
    assert.equal(await m.SchedulingLock.countDocuments({ until: { $gt: new Date() } }), 0, 'released');

    // An expired lock is taken over.
    await m.SchedulingLock.create({ key: 'procedures', until: new Date(Date.now() - 1) });
    assert.equal((await ask()).status, 'booked');

    // A request left waiting by a busy lock is picked up once it is 30 s old.
    await m.SchedulingLock.deleteMany({});
    await m.SchedulingLock.create({ key: 'procedures', until: new Date(Date.now() + 30_000) });
    const d = await ask();
    assert.equal(d.status, 'requested');
    await m.SchedulingLock.deleteMany({});
    mock.timers.tick(31_000);
    assert.equal(await procedures.retryWaiting(), 1);
    assert.equal((await procedures.get(d.id)).status, 'booked');
  });

  test("retryWaiting books the oldest can't-book first", async () => {
    await cathTeam({ rostered: false });
    await roster(arun);
    await roster(anitha);
    const first = await ask('urgent');
    mock.timers.tick(1_000);
    const second = await ask('urgent');
    assert.deepEqual([first.status, second.status], ['cant-book', 'cant-book']);
    await roster(ravi);
    assert.equal(await procedures.retryWaiting(), 2);
    assert.equal(ms((await procedures.get(first.id)).start), at(D, '08:00').getTime());
    assert.equal(ms((await procedures.get(second.id)).start), at(D, '09:00').getTime());
  });

  test("the planner is fed the doctor's OPD sessions that hold bookings, and the day's load", async () => {
    await cathTeam();
    const userId = arun.userId;
    const doctor = await m.OpDoctor.create({
      name: 'Dr. Arun', departmentCode: 'CARD', fee: 500, room: 'Room 201', tokenPrefix: 'C',
      sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '10:00' }], active: true, userId,
    });
    const apt = await m.Appointment.create({ uhid: 'MHK1', patientName: 'Lakshmi', age: 50, gender: 'Female', date: D, time: '09:00 AM', status: 'Scheduled', doctorId: String(doctor._id) });
    assert.equal(ms((await ask()).start), at(D, '10:00').getTime(), 'Dr. Arun is in clinic until 10:00');
    await procedures.cancel(DOC, (await m.ProcedureBooking.findOne().lean())!._id.toString(), 'Test');
    await m.Appointment.updateOne({ _id: apt._id }, { $set: { status: 'Canceled' } });
    assert.equal(ms((await ask()).start), at(D, '08:00').getTime(), 'a session with no live booking does not hold him');

    // A second cath nurse: the one with fewer booked minutes that day is picked.
    const beena = await staff('Beena', ['cath-nurse']);
    await roster(beena);
    const next = await ask();
    assert.equal(next.team.find((t: any) => t.role === 'cath-nurse')!.name, 'Beena', 'Anitha has 45 minutes booked today');
  });

  test('list and board; request refuses bad input', async () => {
    await cathTeam();
    const a = await ask();
    const later = await ask('routine', 'coronary-angiography', { earliest: D1 }); // nobody rostered on D1 or after
    assert.equal(later.status, 'cant-book');
    assert.equal(ms(later.earliest), parseIsoDay(D1).getTime());
    await m.RoomBlock.create({ room: 'ot-1', from: at(D, '12:00'), to: at(D, '16:00'), reason: 'Deep clean', by: { id: 'a', name: 'Admin' } });

    assert.deepEqual((await procedures.list({ status: 'booked' })).map((v) => v.id), [a.id]);
    assert.deepEqual((await procedures.list({ status: 'cant-book' })).map((v) => v.id), [later.id]);
    assert.deepEqual((await procedures.list({ day: D })).map((v) => v.id), [a.id]);
    assert.equal((await procedures.list({ patientId })).length, 2);

    const board = await procedures.board(D);
    assert.equal(board.day, D);
    assert.equal(board.rooms.length, 7);
    const cath = board.rooms.find((r) => r.key === 'cath-lab')!;
    assert.deepEqual([cath.name, cath.open, cath.close, cath.turnover], ['Cath lab', '08:00', '18:00', 15]);
    assert.deepEqual(cath.bookings.map((v) => v.id), [a.id]);
    assert.equal(board.rooms.find((r) => r.key === 'ot-1')!.blocks.length, 1);
    assert.deepEqual(board.waiting.map((v) => v.id), [later.id]);

    await assert.rejects(procedures.list({ status: 'bogus' }), BadRequestException);
    await assert.rejects(procedures.board('20-10-2026'), BadRequestException);
    await assert.rejects(ask('routine', 'heart-transplant'), BadRequestException);
    await assert.rejects(ask('soon' as any), BadRequestException);
    await assert.rejects(ask('routine', 'coronary-angiography', { earliest: 'tomorrow' }), BadRequestException);
    await assert.rejects(ask('routine', 'coronary-angiography', { note: 'x'.repeat(301) }), BadRequestException);
    await assert.rejects(procedures.request(DOC, { patientId: String(new Types.ObjectId()), procedure: 'chest-xray', priority: 'routine' }), NotFoundException);
    assert.equal(await m.ProcedureBooking.countDocuments(), 2, 'nothing saved for a refused request');
  });
});
