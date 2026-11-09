import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { DOC, PHARM, World, amoxicillin500, buildWorld, enoxaparin60, omeprazole20, pantoprazole40 } from '../../test/pharmacy-fixtures';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { BedEvents } from '../beds/bed-events';
import { BedsService } from '../beds/beds.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { RulesService } from '../coordinator/rules.service';
import { OpdService } from '../opd/opd.service';
import { PatientsService } from '../patients/patients.service';
import { SchedulingAppointmentsService } from '../scheduling/scheduling-appointments.service';
import { SCHEDULING_MESSAGE_TYPES } from '../scheduling/scheduling-coordinator.registration';
import { SchedulingDoctorsService } from '../scheduling/scheduling-doctors.service';
import { SchedulingFollowupsService } from '../scheduling/scheduling-followups.service';
import { SchedulingWaitlistService } from '../scheduling/scheduling-waitlist.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeOrdersService, OrderInput } from './discharge-orders.service';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeSummaryService } from './discharge-summary.service';
import { toRealTime } from './discharge-time';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const NURSE = { id: 'n1', name: 'Nurse Anjali Thomas', role: UserRole.NURSE };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };
const MIN = 60_000;
const BED = 'GWA-12';
/** A clinic-clock (local) moment in September 2026. */
const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min, 0, 0);
/** A day order: 26 Sep 11:00. */
const NOW = at(26, 11);
/** An evening order: 26 Sep 20:00. */
const EVENING = at(26, 20);
const DIAGNOSIS = 'Community-acquired pneumonia, treated';
const NOT_SAVED = 'Discharge order not saved';
const ALL_DAY = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00' }];

describe('DischargeOrdersService', () => {
  const m = models();
  let w: World;
  let reg: DischargeRegistration;
  let plans: DischargePlansService;
  let orders: DischargeOrdersService;
  let lines: DischargeLinesService;
  let shajin: any;
  let caseId: string;
  let planId: string;
  let admissionId: string;
  let touches: number;
  let savedClinic: string | undefined;
  /** Every send the service asked for: the Coordinator drops a repeat within a minute, so stored messages can't show one. */
  let sends: { type: string; caseId: string | null; payload: Record<string, unknown>; summary: string }[];
  /** When set, the next sends of this type fail as a Coordinator outage would. */
  let failNext: { type: string; times: number } | null;
  /** Run inside a send, just before it reaches the Coordinator, and just after: to force an interleaving. */
  let beforeForward: ((type: string) => Promise<void>) | null;
  let afterForward: ((type: string) => Promise<void>) | null;
  let logged: string[];

  const sendsOf = (type: string) => sends.filter((s) => s.type === type);
  const stored = (id: unknown) => m.DischargeOrder.findById(id).lean<any>();
  const planOf = (id = planId) => m.DischargePlan.findById(id).lean<any>();
  const clocksOf = (orderId: unknown) => m.Clock.find({ ref: String(orderId) }).sort({ def: 1 }).lean<any[]>();
  const takeHomes = (onCase = caseId) => m.PharmacyOrder.find({ case: onCase, takeHome: true }).sort({ _id: 1 }).lean<any[]>();
  const linesOf = (orderId: unknown) => m.PharmacyLine.find({ order: orderId }).sort({ _id: 1 }).lean<any[]>();
  const near = (actual: unknown, expected: number, what: string) => {
    const t = new Date(actual as string).getTime();
    assert.ok(Math.abs(t - expected) <= 5_000, `${what}: ${new Date(t).toISOString()} is not ${new Date(expected).toISOString()}`);
  };
  /** A Home order for now + 1 h with one take-home medicine and a follow-up in 7 days with Dr. Shajin. */
  const home = (extra: Partial<OrderInput> = {}): OrderInput => ({
    kind: 'home',
    plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN),
    diagnosis: DIAGNOSIS,
    condition: 'improved',
    note: 'Walks unaided; eating well',
    takeHome: { lines: [pantoprazole40] },
    followUp: { inDays: 7, doctorId: String(shajin._id), note: 'Review the chest' },
    ...extra,
  });
  /** A Home order given at 20:00 for 10:00 tomorrow, with nothing to take home and no follow-up. */
  const tomorrow = (extra: Partial<OrderInput> = {}): OrderInput => ({
    kind: 'home', plannedLeaveAt: at(27, 10), diagnosis: DIAGNOSIS, condition: 'stable', takeHome: 'none', followUp: 'none', ...extra,
  });
  const planRow = (extra: Record<string, unknown> = {}) =>
    m.DischargePlan.create({
      admission: new Types.ObjectId(), case: caseId, patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar',
      bedLabel: BED, wardName: 'General ward A (men)', doctor: 'Dr. Shajin', targetDay: '2026-09-26', targetAt: at(26, 11), state: 'planned', ...extra,
    });
  /** Another patient with an open ward case and a plan of their own. */
  const another = async (uhid: string, name: string) => {
    const p = await m.Patient.create({ uhid, name, age: 48, gender: 'Female', phone: '9100000077' });
    const onCase = String((await w.openWard(String(p._id), uhid, name)).case._id);
    const plan = await planRow({ patient: p._id, patientUhid: uhid, patientName: name, case: onCase, bedLabel: 'GWB-3' });
    return { patientId: String(p._id), caseId: onCase, planId: String(plan._id) };
  };

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    await resetTestDb();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    w = await buildWorld(m, { stubDischarge: false });
    w.registry.register({ key: 'scheduling', messageTypes: SCHEDULING_MESSAGE_TYPES, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new DischargeSettingsService(settingsService);
    const rules = new RulesService(w.registry, settingsService, new CoordinatorEvents());
    reg = new DischargeRegistration(w.registry, w.messages, w.cases, settings, m.DischargePlan, m.DischargeOrder, m.Admission);
    logged = [];
    const logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
    (reg as any).logger = logger;
    reg.onModuleInit();
    sends = [];
    failNext = null;
    beforeForward = null;
    afterForward = null;
    const send = reg.send.bind(reg);
    reg.send = async (type, onCase, payload, summary, opts) => {
      sends.push({ type, caseId: onCase, payload, summary });
      if (failNext?.type === type && failNext.times > 0) {
        failNext.times -= 1;
        return false;
      }
      await beforeForward?.(type);
      const went = await send(type, onCase, payload, summary, opts);
      await afterForward?.(type);
      return went;
    };
    plans = new DischargePlansService(reg, w.messages, rules, settings, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Case, m.TaskAlertItem, m.Patient);
    const bedEvents = new BedEvents();
    touches = 0;
    bedEvents.changes$.subscribe(() => (touches += 1));
    const beds = new BedsService(m.Ward, m.Bed, m.Admission, new PatientsService(m.Patient), bedEvents, m.DischargeOrder);

    const opd = new OpdService(m.Department, m.OpDoctor, settingsService);
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    shajin = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: ALL_DAY } as any);
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, opd);
    const appts = new SchedulingAppointmentsService(m.Appointment, m.Patient, doctors, opd, new AppointmentEvents());
    const waitlist = new SchedulingWaitlistService(m.WaitItem, m.Appointment, m.Patient, m.FollowUpItem, m.TaskAlertItem, doctors, appts, undefined as any);
    const followUps = new SchedulingFollowupsService(m.Patient, m.FollowUpItem, m.Case, opd, doctors, appts, waitlist, w.messages);

    lines = new DischargeLinesService(
      reg, w.messages, w.cases, m.DischargeOrder, m.DischargePlan, m.DischargeSummary, m.LabRequest, m.LabLine, m.PharmacyLine, m.FollowUpItem, m.Bill, m.ChargeLine,
    );
    (lines as any).logger = logger;
    lines.clock = () => NOW;
    // The summary has its own spec; these tests write the summary records they need themselves.
    const noSummary = { draft: async () => null, archiveForCancel: async () => false } as unknown as DischargeSummaryService;
    orders = new DischargeOrdersService(
      reg, plans, settings, w.cases, beds, w.takeHome, followUps, lines, noSummary, m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.PharmacyLine,
    );
    (orders as any).logger = logger;
    orders.clock = () => NOW;
    caseId = String((await w.openWard()).case._id);
    const plan = await planRow();
    planId = String(plan._id);
    admissionId = String(plan.admission);
  });
  afterEach(() => {
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  test('order for now + 1 h opens the window at once and starts both clocks', async () => {
    const reminder = `discharge-plan:${planId}:reminder`;
    await m.TaskAlertItem.create({ title: `Discharge due today, no order yet: ${BED}`, type: 'System', category: 'Follow-up', priority: 'Medium', status: 'Pending', link: reminder });
    const leaving = NOW.getTime() + 60 * MIN;

    const o = await orders.order(DOC, planId, home());
    const row = await stored(o._id);
    assert.ok(row, 'the order is saved');
    assert.deepEqual(
      [row.kind, row.state, String(row.plan), String(row.admission), String(row.case), String(row.patient), row.diagnosis, row.condition, row.note, row.noTakeHome, row.noFollowUp],
      ['home', 'ordered', planId, admissionId, caseId, w.patientId, DIAGNOSIS, 'improved', 'Walks unaided; eating well', false, false],
    );
    assert.deepEqual(row.orderedBy, { id: DOC.id, name: DOC.name });
    assert.deepEqual([row.orderedAt.getTime(), row.plannedLeaveAt.getTime()], [NOW.getTime(), leaving]);
    // max(order time, leaving time less the 2 h target): the target already reaches back past the order.
    assert.equal(row.windowAt.getTime(), NOW.getTime());
    assert.ok(row.windowOpenedAt, 'the window is open');
    // The order line is done by the ordering doctor; the lines service then reads the rest from the agents' records:
    // no Lab request is waiting, the follow-up is booked, the medicine is still to be issued and the stay has no bill.
    assert.deepEqual(
      row.lines.map((l: any) => [l.key, l.state]),
      [['order', 'done'], ['summary', 'waiting'], ['lab', 'done'], ['take-home', 'waiting'], ['follow-up', 'done'], ['teaching', 'waiting'], ['bill', 'needs-person']],
    );
    assert.deepEqual([row.lines[0].by, row.lines[0].at.getTime()], [{ id: DOC.id, name: DOC.name }, NOW.getTime()]);

    // A3: the take-home order is on the case now, for the planned leaving time.
    const [th] = await takeHomes();
    assert.equal(String(th._id), String(row.takeHomeOrder));
    assert.deepEqual([th.setting, th.priority, th.plannedLeaveAt.getTime()], ['Ward', 'urgent', leaving]);
    assert.deepEqual((await linesOf(th._id)).map((l) => [l.medicine, l.status]), [['pantoprazole', 'to-check']]);
    // A13: the follow-up is booked with Dr. Shajin, and its outcome is kept.
    assert.equal(row.followUp.status, 'booked');
    const fu = await m.FollowUpItem.findById(row.followUp.followUpId).lean<any>();
    assert.deepEqual([fu.status, fu.note, String(fu.appointmentId)], ['Scheduled', 'Review the chest', row.followUp.appointmentId]);

    // The plan is ordered, and its morning reminder closed.
    const plan = await planOf();
    assert.deepEqual([plan.state, String(plan.order)], ['ordered', String(row._id)]);
    assert.equal((await m.TaskAlertItem.findOne({ link: reminder }).lean<any>()).status, 'Completed');

    // discharge.ordered, then discharge.window-opened: on the case, naming the bed, never the patient.
    assert.deepEqual(sends.map((s) => s.type), ['discharge.ordered', 'discharge.window-opened']);
    const ordered = (await w.sent('discharge.ordered'))[0];
    assert.deepEqual([String(ordered.case), ordered.summary], [caseId, `${BED}: Discharge ordered (Home)`]);
    assert.deepEqual({ ...ordered.payload, plannedLeaveAt: new Date(ordered.payload.plannedLeaveAt).getTime() }, {
      orderId: String(row._id), planId, admissionId, bedLabel: BED, kind: 'home', plannedLeaveAt: leaving,
    });
    const opened = (await w.sent('discharge.window-opened'))[0];
    assert.deepEqual([String(opened.case), opened.summary], [caseId, `${BED}: Discharge window opened (Home)`]);
    const p = opened.payload;
    assert.deepEqual(
      [p.orderId, p.admissionId, p.bedLabel, p.kind, new Date(p.plannedLeaveAt).getTime(), p.summarySigned],
      [String(row._id), admissionId, BED, 'home', leaving, false],
    );
    near(p.leaveDueAt, toRealTime(NOW).getTime() + 120 * MIN, 'leaveDueAt');
    near(p.summaryDueAt, toRealTime(NOW).getTime() + 60 * MIN, 'summaryDueAt');

    // Both clocks run on the case for this order, due when the message says.
    const clocks = await clocksOf(row._id);
    assert.deepEqual(clocks.map((c) => [c.def, c.state, String(c.case)]), [['discharge-leave', 'running', caseId], ['discharge-summary', 'running', caseId]]);
    assert.deepEqual(clocks.map((c) => c.dueAt.getTime()), [new Date(p.leaveDueAt).getTime(), new Date(p.summaryDueAt).getTime()]);
    assert.deepEqual([...row.announced].sort(), ['discharge.ordered', 'discharge.window-opened']);
    assert.equal(touches, 1, 'the bed board re-reads once: the bed is leaving soon');
    assert.deepEqual(logged, []);
  });

  test('order at 20:00 for 10:00 tomorrow opens at 08:00 tomorrow, not before', async () => {
    process.env.CLINIC_DATE = '2026-09-26';
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow());
    let row = await stored(o._id);
    assert.ok(row, 'the order is saved');
    assert.equal(row.windowAt.getTime(), at(27, 8).getTime(), '10:00 less the 2 h target');
    assert.equal(row.windowOpenedAt, undefined);
    // Nothing to take home and no follow-up: both lines are not needed, by the doctor's choice.
    assert.deepEqual(
      row.lines.filter((l: any) => ['take-home', 'follow-up'].includes(l.key)).map((l: any) => [l.key, l.state, l.by?.name]),
      [['take-home', 'not-needed', DOC.name], ['follow-up', 'not-needed', DOC.name]],
    );
    assert.deepEqual([row.noTakeHome, row.noFollowUp, row.takeHomeOrder, row.followUp], [true, true, undefined, undefined]);
    assert.equal((await takeHomes()).length, 0);
    assert.deepEqual(sends.map((s) => s.type), ['discharge.ordered'], 'nobody is paged overnight');
    assert.equal((await clocksOf(row._id)).length, 0);

    assert.equal(await orders.openDueWindows(at(27, 7, 59)), 0);
    assert.equal((await stored(o._id)).windowOpenedAt, undefined);
    assert.equal(sendsOf('discharge.window-opened').length, 0);

    assert.equal(await orders.openDueWindows(at(27, 8)), 1);
    row = await stored(o._id);
    assert.ok(row.windowOpenedAt);
    const [opened] = await w.sent('discharge.window-opened');
    // Clock due times are real time: the clinic's 08:00 tomorrow is tomorrow on the real clock too.
    const realWindow = toRealTime(at(27, 8)).getTime();
    near(opened.payload.leaveDueAt, realWindow + 120 * MIN, 'leaveDueAt');
    near(opened.payload.summaryDueAt, realWindow + 60 * MIN, 'summaryDueAt');
    assert.ok(new Date(opened.payload.leaveDueAt).getTime() > Date.now());
    assert.deepEqual((await clocksOf(row._id)).map((c) => [c.def, c.state, c.dueAt.getTime()]), [
      ['discharge-leave', 'running', new Date(opened.payload.leaveDueAt).getTime()],
      ['discharge-summary', 'running', new Date(opened.payload.summaryDueAt).getTime()],
    ]);
  });

  // ---------- B3-I2: take-home clocks wait for the window ----------

  /** The take-home order's Pharmacy clock of `def` (check or issue), first round. */
  const pharmacyClock = async (def: 'check' | 'issue') => {
    const [th] = await takeHomes();
    return m.Clock.findOne({ def: `pharmacy-${def}`, ref: `${String(th._id)}:${def === 'check' ? 'c' : 'i'}1` }).lean<any>();
  };

  test('B3-I2: an evening order for 10:00 tomorrow starts no Pharmacy clock due before 08:00 tomorrow', async () => {
    process.env.CLINIC_DATE = '2026-09-26';
    orders.clock = () => EVENING;
    await orders.order(DOC, planId, tomorrow({ takeHome: { lines: [pantoprazole40] } }));
    const realWindow = toRealTime(at(27, 8)).getTime();
    const [th] = await takeHomes();
    near(th.dueFrom, realWindow, 'dueFrom');
    near((await pharmacyClock('check')).dueAt, realWindow, 'check due');
    // Approved tonight: the issue waits for the window too.
    const [line] = await linesOf(th._id);
    await w.checks.approve(PHARM, String(line._id), {});
    near((await pharmacyClock('issue')).dueAt, realWindow, 'issue due');
    // Nobody is paged overnight.
    assert.equal(await w.clocks.checkDue(new Date(realWindow - 2 * MIN)), 0);
    assert.equal(await m.Escalation.countDocuments(), 0);
  });

  test('B3-I2: a same-day order keeps the Pharmacy targets', async () => {
    process.env.CLINIC_DATE = '2026-09-26';
    const now = clinicNow();
    orders.clock = () => now;
    await orders.order(DOC, planId, home({ plannedLeaveAt: new Date(now.getTime() + 60 * MIN), followUp: 'none' }));
    const [th] = await takeHomes();
    const [line] = await linesOf(th._id);
    // Urgent: checked within 60 minutes of the order, as any ward order.
    assert.equal((await pharmacyClock('check')).dueAt.getTime(), new Date(line.enteredCheckAt).getTime() + 60 * MIN);
    assert.ok(new Date(th.dueFrom).getTime() < Date.now(), 'the window is already open');
  });

  test('B3-I2: editing the planned time moves the take-home due times and Pharmacy\'s leaving time', async () => {
    process.env.CLINIC_DATE = '2026-09-26';
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow({ takeHome: { lines: [pantoprazole40] } }));
    near((await pharmacyClock('check')).dueAt, toRealTime(at(27, 8)).getTime(), 'check due before');
    await orders.edit(DOC, String(o._id), { plannedLeaveAt: at(27, 12) });
    const [th] = await takeHomes();
    assert.equal(new Date(th.plannedLeaveAt).getTime(), at(27, 12).getTime(), "Pharmacy's leaving time follows (B1-M9)");
    near(th.dueFrom, toRealTime(at(27, 10)).getTime(), 'dueFrom after');
    near((await pharmacyClock('check')).dueAt, toRealTime(at(27, 10)).getTime(), 'check due after');
    assert.equal(await m.Clock.countDocuments({ def: 'pharmacy-check' }), 1);
  });

  test('Start now opens it at once', async () => {
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow());
    assert.ok(await stored(o._id), 'the order is saved');
    assert.equal(sendsOf('discharge.window-opened').length, 0);
    assert.equal((await stored(o._id)).lines.find((l: any) => l.key === 'lab').state, 'done', 'no Lab request yet');
    // A test sent to the lab meanwhile: Start now refreshes the checklist too.
    const request = await m.LabRequest.create({
      number: 'LR-0001', patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar', case: caseId,
      orderedBy: { id: DOC.id, name: DOC.name }, priority: 'urgent', orderedAt: EVENING, collectBy: new Date(),
    });
    await m.LabLine.create({ request: request._id, test: 'crp', status: 'received', tatDueAt: new Date() });

    const pressed = at(26, 20, 30);
    orders.clock = () => pressed;
    await orders.startNow(DOC, String(o._id));
    const row = await stored(o._id);
    assert.deepEqual(
      [row.lines.find((l: any) => l.key === 'lab').state, row.lines.find((l: any) => l.key === 'lab').detail],
      ['waiting', '1 result waiting'],
    );
    assert.equal(row.windowAt.getTime(), pressed.getTime());
    assert.deepEqual([row.startedNow?.by, row.startedNow?.at?.getTime()], [{ id: DOC.id, name: DOC.name }, pressed.getTime()]);
    assert.ok(row.windowOpenedAt);
    const [opened] = await w.sent('discharge.window-opened');
    near(opened.payload.leaveDueAt, toRealTime(pressed).getTime() + 120 * MIN, 'leaveDueAt');
    assert.deepEqual((await clocksOf(row._id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'running']]);

    // Pressed again, or the pass at 08:00: nothing more is sent.
    await orders.startNow(DOC, String(o._id));
    assert.equal(await orders.openDueWindows(at(27, 8)), 0);
    assert.equal(sendsOf('discharge.window-opened').length, 1);
    assert.equal((await stored(o._id)).windowAt.getTime(), pressed.getTime());
  });

  test('a second order on one plan is 409', async () => {
    await orders.order(DOC, planId, home());
    assert.equal(await m.DischargeOrder.countDocuments({ plan: planId }), 1);
    const before = [(await takeHomes()).length, await m.FollowUpItem.countDocuments(), sends.length];
    await assert.rejects(orders.order(DOC, planId, home()), ConflictException);
    // Refused before anything was placed or booked.
    assert.deepEqual([(await takeHomes()).length, await m.FollowUpItem.countDocuments(), sends.length], before);
    assert.equal(await m.DischargeOrder.countDocuments({ plan: planId }), 1);

    // Two at once on another plan: one order. The unique index stops the other, whose take-home order is cancelled.
    const mary = await another('MHK202600902', 'Mary Jeni');
    const results = await Promise.allSettled([
      orders.order(DOC, mary.planId, home({ followUp: 'none' })),
      orders.order(DOC, mary.planId, home({ followUp: 'none' })),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof ConflictException, String(lost.reason));
    const saved = await m.DischargeOrder.find({ plan: mary.planId }).lean<any[]>();
    assert.equal(saved.length, 1);
    for (const th of await takeHomes(mary.caseId)) {
      if (String(th._id) === String(saved[0].takeHomeOrder)) continue;
      assert.deepEqual((await linesOf(th._id)).map((l) => [l.status, l.cancelled?.reason]), [['cancelled', NOT_SAVED]]);
    }

    // A completed plan is never ordered again.
    const done = await planRow({ state: 'completed' });
    await assert.rejects(orders.order(DOC, String(done._id), home({ followUp: 'none', takeHome: 'none' })), ConflictException);
  });

  test('Home without a follow-up choice is 400', async () => {
    const bad: Partial<OrderInput>[] = [
      { followUp: undefined },
      { takeHome: undefined },
      { diagnosis: '   ' },
      { diagnosis: 'x'.repeat(301) },
      { note: 'x'.repeat(1001) },
      { condition: 'cured' as any },
      { kind: 'sideways' as any },
      { followUp: { inDays: 0, doctorId: String(shajin._id) } },
      { takeHome: { lines: [] } },
      // The planned leaving time runs from now to the end of tomorrow.
      { plannedLeaveAt: at(26, 10, 59) },
      { plannedLeaveAt: at(28, 0) },
      { plannedLeaveAt: 'soon' },
      // A transfer names the receiving hospital and the reason; only a transfer does.
      { kind: 'transfer', followUp: undefined },
      { kind: 'transfer', followUp: undefined, receivingHospital: 'Medical College Hospital, Trivandrum' },
      { receivingHospital: 'Medical College Hospital, Trivandrum' },
      { kind: 'transfer', receivingHospital: 'Medical College Hospital, Trivandrum', transferReason: 'Cardiothoracic surgery' },
      // R30: a transfer's take-home line is required too, so the doctor chooses medicines or none.
      { kind: 'transfer', followUp: undefined, takeHome: undefined, receivingHospital: 'Medical College Hospital, Trivandrum', transferReason: 'Cardiothoracic surgery' },
    ];
    for (const extra of bad) {
      await assert.rejects(orders.order(DOC, planId, home(extra)), BadRequestException, JSON.stringify(extra));
    }
    // Refused before anything was placed, booked, saved or sent.
    assert.deepEqual([await m.DischargeOrder.countDocuments(), (await takeHomes()).length, await m.FollowUpItem.countDocuments(), sends.length], [0, 0, 0, 0]);
    assert.equal((await planOf()).state, 'planned');

    // A transfer with both, and no follow-up line at all.
    const t = await orders.order(DOC, planId, home({
      kind: 'transfer', followUp: undefined, takeHome: 'none', receivingHospital: 'Medical College Hospital, Trivandrum', transferReason: 'Cardiothoracic surgery',
    }));
    const row = await stored(t._id);
    assert.deepEqual([row.receivingHospital, row.transferReason], ['Medical College Hospital, Trivandrum', 'Cardiothoracic surgery']);
    assert.deepEqual(row.lines.map((l: any) => [l.key, l.state]), [['order', 'done'], ['summary', 'waiting'], ['lab', 'done'], ['take-home', 'not-needed'], ['teaching', 'waiting'], ['bill', 'needs-person']]);
  });

  test('Died with a future time of death is 400', async () => {
    const died = (extra: Partial<OrderInput> = {}): OrderInput => ({
      kind: 'died', diagnosis: 'Acute myocardial infarction', timeOfDeath: at(26, 10, 40), causeOfDeath: 'Cardiogenic shock', ...extra,
    });
    for (const extra of [
      { timeOfDeath: at(26, 11, 1) },
      { timeOfDeath: undefined },
      { causeOfDeath: '' },
      { condition: 'stable' as const },
      { takeHome: { lines: [pantoprazole40] } },
      { followUp: { inDays: 7, doctorId: String(shajin._id) } },
      // A death leaves at the order's own time: a sent leaving time is refused, as the other foreign fields are.
      { plannedLeaveAt: at(27, 10) },
    ]) {
      await assert.rejects(orders.order(DOC, planId, died(extra)), BadRequestException, JSON.stringify(extra));
    }
    assert.equal(await m.DischargeOrder.countDocuments(), 0);

    // The leaving time of a death is the order's own time, so its window opens at once.
    const o = await orders.order(DOC, planId, died());
    const row = await stored(o._id);
    assert.deepEqual([row.timeOfDeath.getTime(), row.causeOfDeath, row.condition, row.plannedLeaveAt.getTime(), row.windowAt.getTime()], [
      at(26, 10, 40).getTime(), 'Cardiogenic shock', undefined, NOW.getTime(), NOW.getTime(),
    ]);
    assert.ok(row.windowOpenedAt);
    assert.deepEqual(row.lines.map((l: any) => [l.key, l.state]), [
      ['order', 'done'], ['summary', 'waiting'], ['death-certificate', 'waiting'], ['body-handover', 'waiting'], ['bill', 'needs-person'],
    ]);
    assert.deepEqual([row.takeHomeOrder, row.followUp, (await takeHomes()).length], [undefined, undefined, 0]);
    assert.equal((await w.sent('discharge.window-opened'))[0].summary, `${BED}: Discharge window opened (Died)`);
  });

  test('B1-M4: a time of death before the admission is 400; at the admission it is taken', async () => {
    const admission = await m.Admission.create({
      patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar', bed: new Types.ObjectId(), roomClass: 'general', expectedStayDays: 3,
      admittedAt: at(24, 10), admittedBy: 'Front Desk',
    });
    await m.DischargePlan.updateOne({ _id: planId }, { $set: { admission: admission._id } });
    const died = (timeOfDeath: Date): OrderInput => ({ kind: 'died', diagnosis: 'Acute myocardial infarction', timeOfDeath, causeOfDeath: 'Cardiogenic shock' });
    await assert.rejects(orders.order(DOC, planId, died(at(24, 9, 59))), (e: unknown) => {
      assert.ok(e instanceof BadRequestException);
      assert.equal((e as Error).message, 'The time of death cannot be before the admission (24 Sep 2026, 10:00 AM).');
      return true;
    });
    assert.equal(await m.DischargeOrder.countDocuments(), 0);
    const o = await orders.order(DOC, planId, died(at(24, 10)));
    assert.equal((await stored(o._id)).timeOfDeath.getTime(), at(24, 10).getTime());
  });

  test('a nurse cannot order', async () => {
    for (const who of [NURSE, DESK, PHARM]) {
      await assert.rejects(orders.order(who, planId, home()), ForbiddenException, who.name);
    }
    assert.deepEqual([await m.DischargeOrder.countDocuments(), (await takeHomes()).length, sends.length], [0, 0, 0]);
    // An admin can; a nurse can't change, cancel or start it.
    orders.clock = () => EVENING;
    const o = await orders.order(ADMIN, planId, tomorrow());
    assert.ok(o?._id && (await stored(o._id)), 'the order is saved');
    const id = String(o._id);
    await assert.rejects(orders.edit(NURSE, id, { note: 'x' }), ForbiddenException);
    await assert.rejects(orders.cancel(NURSE, id, 'Changed my mind'), ForbiddenException);
    await assert.rejects(orders.startNow(NURSE, id), ForbiddenException);
    const row = await stored(id);
    assert.deepEqual([row.state, row.note, row.windowOpenedAt], ['ordered', '', undefined]);
  });

  test('a failing follow-up cancels the take-home order and saves nothing', async () => {
    await assert.rejects(orders.order(DOC, planId, home({ followUp: { inDays: 7, departmentCode: 'nope' } })), BadRequestException);
    assert.equal(await m.DischargeOrder.countDocuments(), 0);
    const [th] = await takeHomes();
    assert.ok(th, 'the take-home order was placed first');
    assert.deepEqual((await linesOf(th._id)).map((l) => [l.status, l.cancelled?.reason, l.cancelled?.by?.name]), [['cancelled', NOT_SAVED, 'Discharge Agent']]);
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.order], ['planned', undefined]);
    assert.deepEqual([sends.length, touches], [0, 0]);

    // A take-home order Pharmacy refuses: nothing is booked or saved.
    await assert.rejects(orders.order(DOC, planId, home({ takeHome: { lines: [{ ...pantoprazole40, product: 'no-such-product' }] } })), BadRequestException);
    assert.deepEqual([await m.DischargeOrder.countDocuments(), await m.FollowUpItem.countDocuments(), (await takeHomes()).length], [0, 0, 1]);
  });

  test('cancel returns the plan to planned, cancels the take-home lines through Pharmacy and stops the clocks', async () => {
    const o = await orders.order(DOC, planId, home());
    const id = String(o._id);
    assert.equal((await clocksOf(id)).filter((c) => c.state === 'running').length, 2);
    const followUp = (await stored(id)).followUp;
    const cancelledAt = at(26, 11, 30);
    orders.clock = () => cancelledAt;

    await assert.rejects(orders.cancel(DOC, id, '   '), BadRequestException);
    await assert.rejects(orders.cancel(DOC, id, 'x'.repeat(301)), BadRequestException);
    const touched = touches;
    await orders.cancel(DOC, id, '  Spiked a fever again  ');
    const row = await stored(id);
    assert.deepEqual([row.state, row.cancelled.by, row.cancelled.reason, row.cancelled.at.getTime()], [
      'cancelled', { id: DOC.id, name: DOC.name }, 'Spiked a fever again', cancelledAt.getTime(),
    ]);
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.order], ['planned', undefined]);
    assert.equal(touches, touched + 1, 'the bed is no longer leaving soon');

    // The reason stays on the order, never in the message.
    const [msg] = await w.sent('discharge.cancelled');
    assert.deepEqual([String(msg.case), msg.summary, msg.payload], [caseId, `${BED}: Discharge cancelled (Home)`, { orderId: id, admissionId, bedLabel: BED }]);
    // Pharmacy cancels the waiting take-home lines itself (A12).
    assert.deepEqual((await linesOf(row.takeHomeOrder)).map((l) => [l.status, l.cancelled?.reason]), [['cancelled', 'Discharge cancelled']]);
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'met'], ['discharge-summary', 'met']]);
    // A booked follow-up stays.
    assert.equal((await m.FollowUpItem.findById(followUp.followUpId).lean<any>()).status, 'Scheduled');
    assert.equal((await m.Appointment.findById(followUp.appointmentId).lean<any>()).status, 'Scheduled');

    await assert.rejects(orders.cancel(DOC, id, 'Again'), ConflictException);
    await assert.rejects(orders.edit(DOC, id, { note: 'x' }), ConflictException);
    await assert.rejects(orders.startNow(DOC, id), ConflictException);
    // The plan can be ordered again.
    const again = await orders.order(DOC, planId, home({ followUp: 'none' }));
    assert.equal((await planOf()).state, 'ordered');
    assert.equal(String((await planOf()).order), String(again._id));
  });

  test('openDueWindows twice sends one window-opened', async () => {
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow());
    assert.ok(o?._id && (await stored(o._id)), 'the order is saved');
    const id = String(o._id);
    // A send that fails gives the window back, for the next pass.
    failNext = { type: 'discharge.window-opened', times: 1 };
    assert.equal(await orders.openDueWindows(at(27, 8)), 0);
    assert.equal((await stored(id)).windowOpenedAt, undefined);

    const [a, b] = await Promise.all([orders.openDueWindows(at(27, 8, 1)), orders.openDueWindows(at(27, 8, 1))]);
    assert.equal(a + b, 1);
    assert.equal(await orders.openDueWindows(at(27, 9)), 0);
    assert.equal(sendsOf('discharge.window-opened').length, 2, 'the failed one and one more');
    assert.equal((await w.sent('discharge.window-opened')).length, 1);
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'running']]);
    assert.ok((await stored(id)).announced.includes('discharge.window-opened'));
  });

  test('summary signed before the window: no summary clock starts when the window opens, and no escalation', async () => {
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow());
    assert.ok(o?._id && (await stored(o._id)), 'the order is saved');
    const id = String(o._id);
    await m.DischargeSummary.create({ order: o._id, kind: 'home', course: { text: 'Treated with antibiotics.', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: at(26, 21) });

    assert.equal(await orders.openDueWindows(at(27, 8)), 1);
    const [opened] = await w.sent('discharge.window-opened');
    assert.equal(opened.payload.summarySigned, true);
    assert.deepEqual((await clocksOf(id)).map((c) => c.def), ['discharge-leave']);
    // Past the summary's due time, before the leaving one: nothing expires and nobody is paged.
    const leaveDue = new Date(opened.payload.leaveDueAt).getTime();
    assert.equal(await w.clocks.checkDue(new Date(leaveDue - 30 * MIN)), 0);
    assert.equal(await m.Escalation.countDocuments(), 0);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `discharge-order:${id}:summary` }), 0);
  });

  test('edit moves a closed window with the planned time, adds take-home medicines as a second order until one is issued, and books a missing follow-up', async () => {
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow({ takeHome: { lines: [pantoprazole40] } }));
    assert.ok(o?._id && (await stored(o._id)), 'the order is saved');
    const id = String(o._id);

    await orders.edit(DOC, id, { plannedLeaveAt: at(27, 12), diagnosis: '  Pneumonia, resolved ', condition: 'improved', note: 'Home with family' });
    let row = await stored(id);
    assert.deepEqual([row.plannedLeaveAt.getTime(), row.windowAt.getTime(), row.diagnosis, row.condition, row.note], [
      at(27, 12).getTime(), at(27, 10).getTime(), 'Pneumonia, resolved', 'improved', 'Home with family',
    ]);
    assert.equal(row.windowOpenedAt, undefined);
    // Leaving at 21:00 tonight: 21:00 less the target is already past, so the window starts now (B1-M1) and opens.
    orders.clock = () => at(26, 20, 15);
    await orders.edit(DOC, id, { plannedLeaveAt: at(26, 21) });
    row = await stored(id);
    assert.deepEqual([row.windowAt.getTime(), !!row.windowOpenedAt], [at(26, 20, 15).getTime(), true]);
    assert.equal(sendsOf('discharge.window-opened').length, 1);
    // Once open, a new planned time leaves the window where it is.
    await orders.edit(DOC, id, { plannedLeaveAt: at(26, 22) });
    row = await stored(id);
    assert.deepEqual([row.plannedLeaveAt.getTime(), row.windowAt.getTime()], [at(26, 22).getTime(), at(26, 20, 15).getTime()]);
    assert.equal(sendsOf('discharge.window-opened').length, 1);

    // More medicines: a second take-home order beside the first.
    const first = String(row.takeHomeOrder);
    await orders.edit(DOC, id, { takeHome: { lines: [amoxicillin500] } });
    row = await stored(id);
    assert.equal(String(row.takeHomeOrder), first);
    assert.equal(row.addedTakeHomeOrders.length, 1);
    assert.deepEqual((await takeHomes()).map((t) => String(t._id)), [first, String(row.addedTakeHomeOrders[0])]);
    assert.deepEqual((await linesOf(row.addedTakeHomeOrders[0])).map((l) => [l.medicine, l.status]), [['amoxicillin', 'to-check']]);

    // A follow-up, as none is stored: the not-needed line waits again, and the refresh after the edit finds it booked.
    await orders.edit(DOC, id, { followUp: { inDays: 7, doctorId: String(shajin._id) } });
    row = await stored(id);
    const followUpLine = row.lines.find((l: any) => l.key === 'follow-up');
    assert.deepEqual([row.followUp.status, row.noFollowUp, followUpLine.state, followUpLine.by], ['booked', false, 'done', undefined]);
    await assert.rejects(orders.edit(DOC, id, { followUp: { inDays: 10, doctorId: String(shajin._id) } }), ConflictException);
    assert.equal(await m.FollowUpItem.countDocuments(), 1);

    // Once a take-home medicine is issued, no more can be added here.
    const [issuedLine] = await linesOf(first);
    await m.PharmacyLine.updateOne({ _id: issuedLine._id }, { $set: { status: 'issued' } });
    await assert.rejects(orders.edit(DOC, id, { takeHome: { lines: [omeprazole20] } }), {
      name: 'ConflictException',
      message: 'Take-home medicines were already issued. To add more, cancel the discharge order and order again.',
    });
    assert.equal((await takeHomes()).length, 2);
    // Bad values are 400.
    await assert.rejects(orders.edit(DOC, id, { diagnosis: '' }), BadRequestException);
    await assert.rejects(orders.edit(DOC, id, { plannedLeaveAt: at(28, 9) }), BadRequestException);
  });

  test('B1-M1: an edit to an earlier time opens the window from now, never from the order time, so nothing is overdue at once', async () => {
    // Ordered at 08:00 for 10:00 tomorrow; at 15:00 the doctor brings it forward to 15:05 today.
    orders.clock = () => at(26, 8);
    const o = await orders.order(DOC, planId, tomorrow());
    const id = String(o._id);
    orders.clock = () => at(26, 15);
    await orders.edit(DOC, id, { plannedLeaveAt: at(26, 15, 5) });
    const row = await stored(id);
    assert.deepEqual([row.windowAt.getTime(), !!row.windowOpenedAt], [at(26, 15).getTime(), true]);
    const [opened] = sendsOf('discharge.window-opened');
    near(opened.payload.summaryDueAt, toRealTime(at(26, 15)).getTime() + 60 * MIN, 'summaryDueAt');
    near(opened.payload.leaveDueAt, toRealTime(at(26, 15)).getTime() + 120 * MIN, 'leaveDueAt');
  });

  test('R61 M6: a follow-up no longer booked or waitlisted in Scheduling can be replaced by an edit; a live one cannot', async () => {
    const o = await orders.order(DOC, planId, home());
    const id = String(o._id);
    const first = (await stored(id)).followUp;
    assert.equal(first.status, 'booked');
    // Booked: still 409.
    await assert.rejects(orders.edit(DOC, id, { followUp: { inDays: 10, doctorId: String(shajin._id) } }), {
      name: 'ConflictException', message: 'A follow-up is already booked. Change it in Scheduling.',
    });
    for (const status of ['Pending']) {
      await m.FollowUpItem.updateOne({ _id: first.followUpId }, { $set: { status } });
      await assert.rejects(orders.edit(DOC, id, { followUp: { inDays: 10, doctorId: String(shajin._id) } }), ConflictException, status);
    }
    // Missed in Scheduling: the doctor books a new one here, and it replaces the old on the order.
    await m.FollowUpItem.updateOne({ _id: first.followUpId }, { $set: { status: 'Missed' } });
    assert.equal((await stored(id)).lines.find((l: any) => l.key === 'follow-up').state, 'done', 'not refreshed yet');
    await orders.edit(DOC, id, { followUp: { inDays: 10, doctorId: String(shajin._id) } });
    let row = await stored(id);
    assert.notEqual(row.followUp.followUpId, first.followUpId);
    assert.deepEqual([row.followUp.status, row.noFollowUp], ['booked', false]);
    assert.equal((await m.FollowUpItem.findById(row.followUp.followUpId).lean<any>()).status, 'Scheduled');
    assert.equal(row.lines.find((l: any) => l.key === 'follow-up').state, 'done');
    assert.equal(await m.FollowUpItem.countDocuments(), 2);
    // Gone from Scheduling altogether: replaced too.
    await m.FollowUpItem.deleteOne({ _id: row.followUp.followUpId });
    await orders.edit(DOC, id, { followUp: { inDays: 14, doctorId: String(shajin._id) } });
    row = await stored(id);
    assert.equal((await m.FollowUpItem.findById(row.followUp.followUpId).lean<any>()).status, 'Scheduled');
  });

  test('R29: once the window is open, the planned time cannot move past its target', async () => {
    // Ordered at 11:00 for 13:00: 13:00 less the 2 h target is the order time, so the window opens at 11:00.
    const o = await orders.order(DOC, planId, home({ plannedLeaveAt: at(26, 13), followUp: 'none' }));
    assert.ok(o?._id && (await stored(o._id))?.windowOpenedAt, 'the window is open');
    const id = String(o._id);
    orders.clock = () => at(26, 12);
    await assert.rejects(orders.edit(DOC, id, { plannedLeaveAt: at(27, 10) }), (e: unknown) => {
      assert.ok(e instanceof ConflictException);
      assert.equal((e as ConflictException).message, 'The discharge window is already open. Cancel and re-order to leave later.');
      return true;
    });
    await assert.rejects(orders.edit(DOC, id, { plannedLeaveAt: at(26, 13, 1) }), ConflictException);
    assert.equal((await stored(id)).plannedLeaveAt.getTime(), at(26, 13).getTime());
    // Earlier, or anywhere up to the window's target, is fine; the window and its clocks stay.
    await orders.edit(DOC, id, { plannedLeaveAt: at(26, 12, 30) });
    await orders.edit(DOC, id, { plannedLeaveAt: at(26, 13) });
    const row = await stored(id);
    assert.deepEqual([row.plannedLeaveAt.getTime(), row.windowAt.getTime()], [at(26, 13).getTime(), NOW.getTime()]);
    assert.equal(sendsOf('discharge.window-opened').length, 1);
  });

  test('I1: a cancel that lands while the window opens leaves discharge.cancelled due again', async () => {
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow());
    assert.ok(o?._id && (await stored(o._id)), 'the order is saved');
    const id = String(o._id);
    // The cancel lands after the window is claimed and before window-opened reaches the Coordinator: its stop goes first.
    beforeForward = async (type) => {
      if (type !== 'discharge.window-opened') return;
      beforeForward = null;
      await orders.cancel(DOC, id, 'Spiked a fever again');
    };
    assert.equal(await orders.openDueWindows(at(27, 8)), 1);
    const row = await stored(id);
    assert.equal(row.state, 'cancelled');
    const order = await m.AgentMessage.find({ type: { $in: ['discharge.cancelled', 'discharge.window-opened'] } }).sort({ createdAt: 1, _id: 1 }).lean<any[]>();
    assert.deepEqual(order.map((x) => x.type), ['discharge.cancelled', 'discharge.window-opened']);
    // The late start opened clocks the earlier stop could not stop, so the record says the stop is due again.
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'running']]);
    assert.ok(row.announced.includes('discharge.window-opened'));
    assert.ok(!row.announced.includes('discharge.cancelled'), row.announced.join(', '));
    assert.ok(logged.some((l) => /cancelled while its window was opening/.test(l)), logged.join(' | '));
    // Sent again by the one-minute pass (after the Coordinator's 60 s dedupe), it stops them.
    await w.messages.send({
      case: caseId, from: 'discharge', to: ['coordinator'], type: 'discharge.cancelled', priority: 'medium', summary: `${BED}: Discharge cancelled (Home)`,
      payload: { orderId: id, admissionId, bedLabel: BED }, dedupeKey: `discharge.cancelled:${id}:again`,
    });
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'met'], ['discharge-summary', 'met']]);
  });

  test('I1: the stop is due again also when the cancel finishes after the window opened', async () => {
    orders.clock = () => EVENING;
    const o = await orders.order(DOC, planId, tomorrow());
    assert.ok(o?._id && (await stored(o._id)), 'the order is saved');
    const id = String(o._id);
    let cancelStored!: () => void;
    const isStored = new Promise<void>((resolve) => (cancelStored = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let cancelling: Promise<unknown> | null = null;
    // The cancel's stop is stored first, then window-opened, and only then does the cancel record its own message.
    beforeForward = async (type) => {
      if (type !== 'discharge.window-opened') return;
      beforeForward = null;
      cancelling = orders.cancel(DOC, id, 'Spiked a fever again');
      await isStored;
    };
    afterForward = async (type) => {
      if (type !== 'discharge.cancelled') return;
      afterForward = null;
      cancelStored();
      await gate;
    };
    assert.equal(await orders.openDueWindows(at(27, 8)), 1);
    release();
    await cancelling;
    const row = await stored(id);
    assert.equal(row.state, 'cancelled');
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['running', 'running']);
    assert.ok(!row.announced.includes('discharge.cancelled'), row.announced.join(', '));
  });

  test('a checklist that fails to refresh never undoes the order: logged, and the one-minute pass reads it again', async () => {
    lines.refresh = async () => {
      throw new Error('database down');
    };
    const o = await orders.order(DOC, planId, home({ followUp: 'none' }));
    const row = await stored(o._id);
    assert.deepEqual([row?.state, (await planOf()).state, String(row?._id)], ['ordered', 'ordered', String(o._id)]);
    assert.deepEqual(sends.map((s) => s.type), ['discharge.ordered', 'discharge.window-opened']);
    assert.ok(logged.some((l) => /checklist not refreshed \(database down\)/.test(l)), logged.join(' | '));
  });

  test('a plan with no case orders on the patient\'s open case', async () => {
    await m.DischargePlan.updateOne({ _id: planId }, { $unset: { case: 1 } });
    const o = await orders.order(DOC, planId, home({ followUp: 'none' }));
    const row = await stored(o._id);
    assert.ok(row, 'the order is saved');
    assert.equal(String(row.case), caseId, 'the case is kept on the order');
    assert.equal(String((await takeHomes())[0]._id), String(row.takeHomeOrder));
    assert.deepEqual(sends.map((s) => s.caseId), [caseId, caseId]);
  });

  test('preview shows the take-home flags on the plan\'s case', async () => {
    await w.orders.order(DOC, { patientId: w.patientId, priority: 'urgent', lines: [enoxaparin60] });
    // The flags show allergies: only the ordering roles may see them.
    for (const who of [NURSE, DESK, PHARM]) {
      await assert.rejects(orders.preview(who, { planId, lines: [enoxaparin60] }), ForbiddenException, who.name);
    }
    const preview = (await orders.preview(DOC, { planId, lines: [enoxaparin60] })) as any;
    assert.equal(preview.lines.length, 1);
    assert.deepEqual(
      preview.lines[0].flags.filter((f: any) => f.kind === 'continues').map((f: any) => [f.severity, f.text]),
      [['info', 'Continues ward medicine']],
    );
    assert.equal(await m.PharmacyOrder.countDocuments({ takeHome: true }), 0, 'nothing is placed');
  });
});
