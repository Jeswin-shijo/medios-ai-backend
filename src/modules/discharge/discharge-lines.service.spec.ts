import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { DOC, PHARM, World, amoxicillin500, buildWorld, pantoprazole40 } from '../../test/pharmacy-fixtures';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { BedEvents } from '../beds/bed-events';
import { BedsService } from '../beds/beds.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { RulesService } from '../coordinator/rules.service';
import { OpdService } from '../opd/opd.service';
import { PatientsService } from '../patients/patients.service';
import { REVENUE_MESSAGE_TYPES } from '../revenue/revenue-coordinator.registration';
import { SchedulingAppointmentsService } from '../scheduling/scheduling-appointments.service';
import { SCHEDULING_MESSAGE_TYPES } from '../scheduling/scheduling-coordinator.registration';
import { SchedulingDoctorsService } from '../scheduling/scheduling-doctors.service';
import { SchedulingFollowupsService } from '../scheduling/scheduling-followups.service';
import { SchedulingWaitlistService } from '../scheduling/scheduling-waitlist.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DischargeLineEntry } from './schemas/discharge-order.schema';
import { DischargeRegistration, WAKE_TYPES } from './discharge-coordinator.registration';
import { DischargeLinesService, isReady, missing } from './discharge-lines.service';
import { DischargeOrdersService, OrderInput } from './discharge-orders.service';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeSummaryService } from './discharge-summary.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const NURSE = { id: 'n1', name: 'Nurse Anjali Thomas', role: UserRole.NURSE };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };
const LAB = { id: 'l1', name: 'Dr. Meera Nair', role: UserRole.LAB };
const MIN = 60_000;
const BED = 'GWA-12';
/** A clinic-clock (local) moment in September 2026. */
const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min, 0, 0);
const NOW = at(26, 11);
const SIGNED = at(26, 11, 30);
const DIAGNOSIS = 'Community-acquired pneumonia, treated';
const ALL_DAY = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '17:00' }];
const status = async () => ({ open: 0, capacity: 0, onTimePct: null });
const keyStates = (rows: DischargeLineEntry[]) => rows.map((l) => [l.key, l.state]);

describe('DischargeLinesService', () => {
  const m = models();
  let w: World;
  let reg: DischargeRegistration;
  let lines: DischargeLinesService;
  let orders: DischargeOrdersService;
  let shajin: any;
  let meena: any;
  let caseId: string;
  let planId: string;
  let admissionId: string;
  let logged: string[];
  let savedClinic: string | undefined;
  let seq: number;

  const stored = (id: unknown) => m.DischargeOrder.findById(id).lean<any>();
  const planOf = (id = planId) => m.DischargePlan.findById(id).lean<any>();
  const lineOf = async (id: unknown, key: string) => (await stored(id)).lines.find((l: any) => l.key === key);
  /** One line's [state, detail]. */
  const stateOf = async (id: unknown, key: string) => {
    const l = await lineOf(id, key);
    return [l?.state, l?.detail];
  };
  /** A Home order for now + 1 h with nothing to take home and no follow-up. */
  const homeNone = (extra: Partial<OrderInput> = {}): OrderInput => ({
    kind: 'home', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'improved', takeHome: 'none', followUp: 'none', ...extra,
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
  const totals = (charges: number, payments: number) => ({ charges, discounts: 0, payments, refunds: 0, balance: charges - payments });
  /** An admission bill of this stay unless `extra` says otherwise. */
  const bill = (extra: Record<string, unknown> = {}) =>
    m.Bill.create({
      number: `BL-${String(++seq).padStart(4, '0')}`, patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar',
      kind: 'admission', state: 'open', case: caseId, admission: admissionId, openedAt: NOW, totals: totals(0, 0), ...extra,
    });
  /** A charge with no price yet (Revenue's "Needs price"). */
  const unpriced = (billId: unknown) =>
    m.ChargeLine.create({
      bill: billId, code: 'blood-culture', name: 'Blood culture', category: 'lab', qty: 1, unitPrice: 0, amount: 0,
      source: { type: 'manual', ref: `manual-${++seq}` }, chargedAt: NOW, by: { id: DESK.id, name: DESK.name }, needsPrice: true,
    });
  /** A Revenue bill message, as Revenue sends it on the bill's case; its handlers run inline. */
  const revenue = (type: string, b: { _id: unknown; number: string; case?: unknown }, extra: Record<string, unknown>) =>
    w.messages.send({
      case: b.case ? String(b.case) : null, from: 'revenue', to: ['coordinator'], type, priority: 'medium', summary: `${b.number}: x`,
      payload: { billId: String(b._id), billNumber: b.number, ...extra }, dedupeKey: `${type}:${new Types.ObjectId()}`,
    });
  /** A Lab request with its tests, on this stay's case unless told otherwise. */
  const labRequest = async (tests: Record<string, unknown>[], onCase: unknown = caseId) => {
    const r = await m.LabRequest.create({
      number: `LR-${String(++seq).padStart(4, '0')}`, patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar', case: onCase,
      orderedBy: { id: DOC.id, name: DOC.name }, priority: 'urgent', orderedAt: NOW, collectBy: new Date(),
    });
    const created = await m.LabLine.insertMany(tests.map((t) => ({ request: r._id, tatDueAt: new Date(), ...t })));
    return { requestId: String(r._id), lineIds: created.map((l) => String(l._id)) };
  };
  /** The order's summary, signed by Dr. Shajin at 11:30 (Task 10 signs through its own service). */
  const sign = (orderId: unknown, kind = 'home') =>
    m.DischargeSummary.create({ order: orderId, kind, course: { text: 'Treated with antibiotics.', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: SIGNED });

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    seq = 0;
    await resetTestDb();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    w = await buildWorld(m, { stubDischarge: false });
    w.registry.register({ key: 'scheduling', messageTypes: SCHEDULING_MESSAGE_TYPES, status });
    w.registry.register({ key: 'revenue', messageTypes: REVENUE_MESSAGE_TYPES, status });
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new DischargeSettingsService(settingsService);
    const rules = new RulesService(w.registry, settingsService, new CoordinatorEvents());
    reg = new DischargeRegistration(w.registry, w.messages, w.cases, settings, m.DischargePlan, m.DischargeOrder, m.Admission);
    logged = [];
    const logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
    (reg as any).logger = logger;
    reg.onModuleInit();
    const plans = new DischargePlansService(reg, w.messages, rules, settings, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Case, m.TaskAlertItem, m.Patient);
    const beds = new BedsService(m.Ward, m.Bed, m.Admission, new PatientsService(m.Patient), new BedEvents(), m.DischargeOrder);

    const opd = new OpdService(m.Department, m.OpDoctor, settingsService);
    await opd.createDepartment({ code: 'gen-med', name: 'General Medicine', tokenPrefix: 'G', icon: 'x', color: '#000000', order: 1, active: true });
    shajin = await opd.createDoctor({ name: 'Dr. Shajin', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'G', sessions: ALL_DAY } as any);
    // No clinic sessions at all: a follow-up with her goes on the waitlist.
    meena = await opd.createDoctor({ name: 'Dr. Meena', qualifications: '', departmentCode: 'gen-med', fee: 300, room: 'Room 101', tokenPrefix: 'M', sessions: [] } as any);
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
    const noDraft = { draft: async () => null } as unknown as DischargeSummaryService;
    orders = new DischargeOrdersService(
      reg, plans, settings, w.cases, beds, w.takeHome, followUps, lines, noDraft, m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.PharmacyLine,
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

  // ---------- Lab ----------

  test('lab waits for a received test and is done once released', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    assert.deepEqual(await stateOf(id, 'lab'), ['done', undefined], 'no Lab request: nothing is waiting');

    const { lineIds } = await labRequest([{ test: 'urine', status: 'received' }, { test: 'crp', status: 'released' }]);
    // Another stay's case, or another patient's, never holds this one.
    await labRequest([{ test: 'coag', status: 'ordered' }], new Types.ObjectId());
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '1 result waiting']);
    // Entered and waiting for a second person: still waiting.
    await m.LabLine.updateOne({ _id: lineIds[0] }, { $set: { status: 'awaiting-validation' } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '1 result waiting']);

    // Released: Lab's own message wakes the agent, which reads Lab's records again.
    await m.LabLine.updateOne({ _id: lineIds[0] }, { $set: { status: 'released' } });
    await w.labResulted(caseId, 'urine');
    assert.deepEqual(await stateOf(id, 'lab'), ['done', undefined]);

    // An amendment puts a released result back to waiting for validation, and the line with it.
    await m.LabLine.updateOne({ _id: lineIds[1] }, { $set: { status: 'awaiting-validation' } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '1 result waiting']);
    // A newly ordered test and one cancelled: only the open one waits.
    await labRequest([{ test: 'cbc', status: 'ordered' }, { test: 'lft', status: 'cancelled' }]);
    await m.LabLine.updateOne({ _id: lineIds[1] }, { $set: { status: 'released' } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '1 result waiting']);
    assert.deepEqual(logged, []);
  });

  test('follow up later makes lab done', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const first = await labRequest([{ test: 'urine', status: 'received' }, { test: 'crp', status: 'received' }]);
    const second = await labRequest([{ test: 'cbc', status: 'collected' }]);
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '3 results waiting']);

    // A doctor's or an admin's call, for a request on this stay.
    for (const who of [NURSE, DESK, LAB, PHARM]) {
      await assert.rejects(lines.followUpLater(who, id, first.requestId), ForbiddenException, who.name);
    }
    const elsewhere = await labRequest([{ test: 'lft', status: 'received' }], new Types.ObjectId());
    await assert.rejects(lines.followUpLater(DOC, id, elsewhere.requestId), NotFoundException);
    await assert.rejects(lines.followUpLater(DOC, id, 'nope'), NotFoundException);
    assert.deepEqual((await stored(id)).followUpLater, []);

    await lines.followUpLater(DOC, id, first.requestId);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '1 result waiting']);
    await lines.followUpLater(ADMIN, id, second.requestId);
    await lines.followUpLater(DOC, id, second.requestId);
    assert.deepEqual((await stored(id)).followUpLater, [first.requestId, second.requestId], 'twice is once');
    assert.deepEqual(await stateOf(id, 'lab'), ['done', '3 results to follow up later']);

    // The results still arrive as usual; once released there is nothing left to follow up.
    await m.LabLine.updateMany({ request: { $in: [first.requestId, second.requestId] } }, { $set: { status: 'released' } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['done', undefined]);

    // An against-advice discharge has no Lab line to put off.
    const mary = await another('MHK202600902', 'Mary Jeni');
    const ama = await orders.order(DOC, mary.planId, { kind: 'against-advice', plannedLeaveAt: new Date(NOW.getTime() + 30 * MIN), diagnosis: DIAGNOSIS, condition: 'unchanged' });
    const theirs = await labRequest([{ test: 'urine', status: 'received' }], mary.caseId);
    await assert.rejects(lines.followUpLater(DOC, String(ama._id), theirs.requestId), BadRequestException);
  });

  test('an unacknowledged critical keeps lab waiting and refuses follow up later', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const { requestId, lineIds } = await labRequest([{ test: 'potassium', status: 'released', critical: { active: true } }]);
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '1 critical result to acknowledge']);
    await assert.rejects(lines.followUpLater(DOC, id, requestId), (e: unknown) => {
      assert.ok(e instanceof ConflictException, String(e));
      assert.match((e as Error).message, /critical/i);
      return true;
    });
    assert.deepEqual((await stored(id)).followUpLater, []);

    // A doctor acknowledges it in the Lab Agent: done.
    await m.LabLine.updateOne({ _id: lineIds[0] }, { $set: { 'critical.ackAt': NOW, 'critical.ackBy': DOC.name } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['done', undefined]);

    // A result put off as follow up later that comes back critical holds the line again: a critical can't be put off.
    const later = await labRequest([{ test: 'troponin', status: 'received' }]);
    await lines.followUpLater(DOC, id, later.requestId);
    assert.deepEqual(await stateOf(id, 'lab'), ['done', '1 result to follow up later']);
    await m.LabLine.updateOne({ _id: later.lineIds[0] }, { $set: { status: 'released', critical: { active: true } } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'lab'), ['waiting', '1 critical result to acknowledge']);
  });

  // ---------- Take-home ----------

  test('take-home done when every line issued or cancelled; none counts', async () => {
    const o = await orders.order(DOC, planId, homeNone({ takeHome: { lines: [pantoprazole40] } }));
    const id = String(o._id);
    assert.deepEqual(await stateOf(id, 'take-home'), ['waiting', '1 medicine waiting in Pharmacy']);
    // More medicines, as a second take-home order: the line waits for both orders' lines.
    await orders.edit(DOC, id, { takeHome: { lines: [amoxicillin500] } });
    assert.deepEqual(await stateOf(id, 'take-home'), ['waiting', '2 medicines waiting in Pharmacy']);
    const row = await stored(id);
    const [a] = await m.PharmacyLine.find({ order: row.takeHomeOrder }).lean();
    const [b] = await m.PharmacyLine.find({ order: row.addedTakeHomeOrders[0] }).lean();

    await m.PharmacyLine.updateOne({ _id: a._id }, { $set: { status: 'issued' } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'take-home'), ['waiting', '1 medicine waiting in Pharmacy']);
    // Pharmacy cancels the other; its own message wakes the agent.
    await w.checks.cancel(DOC, String(b._id), 'He has these at home');
    assert.deepEqual(await stateOf(id, 'take-home'), ['done', '1 issued · 1 cancelled']);
    // Stopped and rejected lines are ended too.
    await m.PharmacyLine.updateOne({ _id: a._id }, { $set: { status: 'stopped' } });
    await m.PharmacyLine.updateOne({ _id: b._id }, { $set: { status: 'rejected' } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'take-home'), ['done', '1 stopped · 1 rejected']);

    // "No take-home medicines": not needed, by the doctor who said so, through every refresh.
    const mary = await another('MHK202600902', 'Mary Jeni');
    const none = await orders.order(DOC, mary.planId, homeNone());
    await lines.refresh(String(none._id));
    const line = await lineOf(none._id, 'take-home');
    assert.deepEqual([line.state, line.by, line.at.getTime(), line.detail], ['not-needed', { id: DOC.id, name: DOC.name }, NOW.getTime(), undefined]);
  });

  test('take-home with no order and no choice waits, never vacuously done', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    // As if the doctor had never chosen (an order from before R30, or a bad record): no take-home order, no "none".
    await m.DischargeOrder.updateOne(
      { _id: o._id, 'lines.key': 'take-home' },
      { $set: { noTakeHome: false, 'lines.$.state': 'waiting' }, $unset: { 'lines.$.by': 1, 'lines.$.at': 1 } },
    );
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'take-home'), ['waiting', 'No take-home medicines ordered yet']);
    // A take-home order whose medicines can't be read waits too.
    await m.DischargeOrder.updateOne({ _id: o._id }, { $set: { takeHomeOrder: new Types.ObjectId() } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'take-home'), ['waiting', 'The take-home order has no medicines']);
    const row = await stored(id);
    assert.ok(missing(row).includes('take-home'));
    assert.equal(lines.isReady(row), false);
  });

  // ---------- Follow-up ----------

  test('follow-up done when booked or waitlisted', async () => {
    const o = await orders.order(DOC, planId, homeNone({ followUp: { inDays: 7, doctorId: String(shajin._id) } }));
    const id = String(o._id);
    const followUpId = (await stored(id)).followUp.followUpId;
    const item = await m.FollowUpItem.findById(followUpId).lean<any>();
    assert.equal(item.status, 'Scheduled');
    assert.deepEqual(await stateOf(id, 'follow-up'), ['done', `Booked: ${item.followUpDate} at ${item.followUpTime}`]);

    // Dr. Meena has no free time: Scheduling puts the follow-up on the waitlist, and the desk will call with a time.
    const mary = await another('MHK202600902', 'Mary Jeni');
    const waiting = await orders.order(DOC, mary.planId, homeNone({ followUp: { inDays: 7, doctorId: String(meena._id) } }));
    const theirs = (await stored(waiting._id)).followUp;
    assert.equal(theirs.status, 'waitlisted');
    assert.equal((await m.FollowUpItem.findById(theirs.followUpId).lean<any>()).status, 'Pending');
    assert.deepEqual(await stateOf(waiting._id, 'follow-up'), ['done', 'On the waitlist: the desk will call']);

    // Missed in Scheduling, or gone: waiting again.
    await m.FollowUpItem.updateOne({ _id: followUpId }, { $set: { status: 'Missed' } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'follow-up'), ['waiting', 'The follow-up is missed in Scheduling']);
    await m.FollowUpItem.deleteOne({ _id: followUpId });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'follow-up'), ['waiting', 'The follow-up was not found in Scheduling']);
  });

  test('not-needed by a nurse is 403', async () => {
    const o = await orders.order(DOC, planId, homeNone({ followUp: { inDays: 7, doctorId: String(shajin._id) } }));
    const id = String(o._id);
    const followUpId = (await stored(id)).followUp.followUpId;
    await m.FollowUpItem.updateOne({ _id: followUpId }, { $set: { status: 'Missed' } });
    await lines.refresh(id);

    // "Not needed" is the doctor's choice.
    for (const who of [NURSE, DESK, PHARM, LAB]) {
      await assert.rejects(lines.tick(who, id, 'follow-up', { state: 'not-needed' }), ForbiddenException, who.name);
    }
    // An agent's line is done from that agent's records, never by hand.
    await assert.rejects(lines.tick(DOC, id, 'follow-up', { state: 'done' }), BadRequestException);
    for (const key of ['order', 'summary', 'lab', 'bill'] as const) {
      await assert.rejects(lines.tick(ADMIN, id, key, { state: 'done' }), BadRequestException, key);
    }
    await assert.rejects(lines.tick(ADMIN, id, 'wristband' as any, { state: 'done' }), BadRequestException);
    await assert.rejects(lines.tick(DOC, id, 'follow-up', { state: 'not-needed', note: 'x'.repeat(301) }), BadRequestException);
    assert.deepEqual(await stateOf(id, 'follow-up'), ['waiting', 'The follow-up is missed in Scheduling']);

    // The doctor says it is not needed: kept, with who said so, through every refresh.
    await lines.tick(DOC, id, 'follow-up', { state: 'not-needed', note: '  His GP will see him next week ' });
    let row = await stored(id);
    let line = row.lines.find((l: any) => l.key === 'follow-up');
    assert.deepEqual([line.state, line.by, line.at.getTime(), line.note, row.noFollowUp], [
      'not-needed', { id: DOC.id, name: DOC.name }, NOW.getTime(), 'His GP will see him next week', true,
    ]);
    await m.FollowUpItem.updateOne({ _id: followUpId }, { $set: { status: 'Scheduled' } });
    await lines.refresh(id);
    line = await lineOf(id, 'follow-up');
    assert.deepEqual([line.state, line.by?.name, line.note], ['not-needed', DOC.name, 'His GP will see him next week']);

    // A nurse's line: a nurse or an admin ticks it done; a doctor can't, and it is never "not needed".
    await assert.rejects(lines.tick(DOC, id, 'teaching', { state: 'done' }), ForbiddenException);
    await assert.rejects(lines.tick(NURSE, id, 'teaching', { state: 'not-needed' }), BadRequestException);
    // Not on a Home checklist.
    await assert.rejects(lines.tick(NURSE, id, 'ama-form', { state: 'done' }), BadRequestException);
    await lines.tick(NURSE, id, 'teaching', { state: 'done', note: 'Explained to his son' });
    await lines.tick(ADMIN, id, 'teaching', { state: 'done', note: 'Again' });
    await lines.refresh(id);
    line = await lineOf(id, 'teaching');
    assert.deepEqual([line.state, line.by?.name, line.at.getTime(), line.note], ['done', NURSE.name, NOW.getTime(), 'Explained to his son'], 'the first tick stays');
  });

  // ---------- Bill ----------

  test('bill done when final with balance 0 or a refund owed', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const b = await bill({ state: 'final', totals: totals(4800, 4800) });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Final bill ready: nothing due']);
    // A short stay paid more in deposit than it used: the hospital owes a refund, which never keeps the patient.
    await m.Bill.updateOne({ _id: b._id }, { $set: { totals: totals(4800, 6000) } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Refund due: billing informed']);
    // Settled: Revenue's own message wakes the agent.
    await m.Bill.updateOne({ _id: b._id }, { $set: { state: 'settled', totals: totals(4800, 4800) } });
    await revenue('revenue.bill-settled', b, { total: 4800 });
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Bill settled']);
  });

  test('waiting while due', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const b = await bill({ totals: totals(6340, 4000) });
    await unpriced(b._id);
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹2,340 due · 1 line needs a price']);
    // Final, with money still due.
    await m.Bill.updateOne({ _id: b._id }, { $set: { state: 'final', totals: totals(6340, 6240) } });
    await revenue('revenue.bill-final', b, { balance: 100 });
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹100 due · 1 line needs a price']);
    // Open with nothing due yet: the final bill is still to be prepared.
    await m.Bill.updateOne({ _id: b._id }, { $set: { state: 'open', totals: totals(3000, 5000) } });
    await m.ChargeLine.updateMany({ bill: b._id }, { $set: { needsPrice: false } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', 'Final bill not prepared yet']);

    // Keep the patient for money owed: everything else done, a Home discharge still waits for the bill.
    await sign(o._id);
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    let row = await stored(id);
    assert.deepEqual([row.state, missing(row)], ['ordered', ['bill']]);
    assert.equal((await w.sent('discharge.ready')).length, 0);

    // Only the stay's own admission bills count: walk-in, OPD and another stay's bills with money due never do.
    await bill({ kind: 'walk-in', admission: undefined, day: '2026-09-26', totals: totals(500, 0) });
    await bill({ kind: 'opd', admission: undefined, day: '2026-09-26', appointment: new Types.ObjectId(), totals: totals(300, 0) });
    await bill({ admission: new Types.ObjectId(), totals: totals(900, 0) });
    await m.Bill.updateOne({ _id: b._id }, { $set: { state: 'final', totals: totals(3000, 3000) } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Final bill ready: nothing due']);
    row = await stored(id);
    assert.equal(row.state, 'ready');
  });

  test('a continuation bill with a balance makes it waiting again', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const first = await bill({ state: 'settled', totals: totals(5000, 5000) });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Bill settled']);
    // A charge after the settlement, with the patient still here, opens a continuation bill for the stay.
    const next = await bill({ continuationOf: first._id, totals: totals(300, 0) });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹300 due']);
    await m.Bill.updateOne({ _id: next._id }, { $set: { state: 'final', totals: totals(300, 300) } });
    await revenue('revenue.bill-final', next, { balance: 0 });
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Final bill ready: nothing due']);
    await m.Bill.updateOne({ _id: next._id }, { $set: { state: 'settled' } });
    await revenue('revenue.bill-settled', next, { total: 300 });
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Bill settled']);
  });

  test('no bill is needs-person, and an admin override makes it done', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    assert.deepEqual(await stateOf(id, 'bill'), ['needs-person', 'Check with billing']);
    for (const who of [DOC, NURSE, DESK, PHARM]) {
      await assert.rejects(lines.overrideBill(who, id, 'Billed on paper'), ForbiddenException, who.name);
    }
    await assert.rejects(lines.overrideBill(ADMIN, id, '   '), BadRequestException);
    await assert.rejects(lines.overrideBill(ADMIN, id, 'x'.repeat(301)), BadRequestException);
    assert.deepEqual(await stateOf(id, 'bill'), ['needs-person', 'Check with billing']);

    await lines.overrideBill(ADMIN, id, '  Billed on the old system; nothing due  ');
    let line = await lineOf(id, 'bill');
    assert.deepEqual([line.state, line.by, line.at.getTime(), line.note, line.detail], [
      'done', { id: ADMIN.id, name: ADMIN.name }, NOW.getTime(), 'Billed on the old system; nothing due', 'No bill found: marked done by an admin',
    ]);
    await lines.refresh(id);
    assert.deepEqual(await lineOf(id, 'bill'), line, 'kept while there is still no bill');

    // Revenue's reconcile opens the bill after all: from then on the line follows the bill.
    await bill({ totals: totals(1200, 0) });
    await lines.refresh(id);
    line = await lineOf(id, 'bill');
    assert.deepEqual([line.state, line.detail, line.by, line.note], ['waiting', '₹1,200 due', undefined, undefined]);
    await assert.rejects(lines.overrideBill(ADMIN, id, 'Nothing due'), ConflictException);
  });

  test('R32: a final bill at ₹0 with an unpriced line waits, and is done once the line is priced (R44)', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const b = await bill({ state: 'final', totals: totals(4800, 4800) });
    const first = await unpriced(b._id);
    await lines.refresh(id);
    // Nothing is due on paper, but an unpriced line is not "nothing due" (Revenue R20).
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '1 line needs a price']);
    const second = await unpriced(b._id);
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '2 lines need a price']);
    // A reversed line no longer counts.
    await m.ChargeLine.updateOne({ _id: second._id }, { $set: { reversed: true } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '1 line needs a price']);
    // Everything else done: a Home discharge is still kept for it.
    await sign(o._id);
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    let row = await stored(id);
    assert.deepEqual([row.state, missing(row)], ['ordered', ['bill']]);

    // The desk's correction confirms the price (R44: here free, at ₹0), which clears Needs price: done, and Ready.
    await m.ChargeLine.updateOne({ _id: first._id }, { $set: { needsPrice: false } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Final bill ready: nothing due']);
    row = await stored(id);
    assert.equal(row.state, 'ready');
  });

  test('R32: a refund owed with an unpriced line still waits', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const b = await bill({ state: 'final', totals: totals(4800, 6000) });
    await unpriced(b._id);
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '1 line needs a price']);
    // Priced: the hospital owes a refund, which never keeps the patient.
    await m.ChargeLine.updateMany({ bill: b._id }, { $set: { needsPrice: false } });
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Refund due: billing informed']);
  });

  test('R32: a settled bill is done whatever its lines say', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    // The desk settled it by hand with a line still unpriced: settling is the desk's own decision.
    const b = await bill({ state: 'settled', totals: totals(4800, 4800) });
    await unpriced(b._id);
    await revenue('revenue.bill-settled', b, { total: 4800 });
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Bill settled']);
    // A continuation bill, final with nothing due but an unpriced line of its own, waits (only its line is counted)...
    const next = await bill({ continuationOf: b._id, state: 'final', totals: totals(200, 200) });
    await unpriced(next._id);
    await lines.refresh(id);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '1 line needs a price']);
    // ...until the desk settles it too.
    await m.Bill.updateOne({ _id: next._id }, { $set: { state: 'settled' } });
    await revenue('revenue.bill-settled', next, { total: 200 });
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Bill settled']);
  });

  test('R32: for a transfer an unpriced line shows on the bill line but never blocks Ready', async () => {
    const o = await orders.order(DOC, planId, {
      kind: 'transfer', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'stable', takeHome: 'none',
      receivingHospital: 'Medical College Hospital, Trivandrum', transferReason: 'Cardiothoracic surgery',
    });
    const id = String(o._id);
    const b = await bill({ state: 'final', totals: totals(3000, 3000) });
    await unpriced(b._id);
    await sign(o._id, 'transfer');
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '1 line needs a price']);
    assert.equal((await stored(id)).state, 'ready');
  });

  // ---------- Transfer and Died ----------

  test('transfer is ready with a bill due', async () => {
    const o = await orders.order(DOC, planId, {
      kind: 'transfer', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'stable', takeHome: 'none',
      receivingHospital: 'Medical College Hospital, Trivandrum', transferReason: 'Cardiothoracic surgery',
    });
    const id = String(o._id);
    await bill({ totals: totals(8200, 3000) });
    await sign(o._id, 'transfer');
    await lines.tick(NURSE, id, 'teaching', { state: 'done', note: 'Documents with the ambulance team' });
    const row = await stored(id);
    // A transfer never waits for the bill: the line is shown with what is due, and Ready is reached.
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹5,200 due']);
    assert.deepEqual([row.state, missing(row), isReady(row)], ['ready', [], true]);
    const [ready] = await w.sent('discharge.ready');
    assert.deepEqual([String(ready.case), ready.summary, ready.payload], [caseId, `${BED}: Ready to leave (Transfer)`, { orderId: id, bedLabel: BED, kind: 'transfer' }]);
  });

  test('died is ready with a bill due', async () => {
    const o = await orders.order(DOC, planId, { kind: 'died', diagnosis: 'Acute myocardial infarction', timeOfDeath: at(26, 10, 40), causeOfDeath: 'Cardiogenic shock' });
    const id = String(o._id);
    await bill({ totals: totals(4200, 0) });
    await sign(o._id, 'died');
    // The certificate is the doctor's line; the body handover the nurse's, naming who received the body.
    await assert.rejects(lines.tick(NURSE, id, 'death-certificate', { state: 'done' }), ForbiddenException);
    await lines.tick(DOC, id, 'death-certificate', { state: 'done', note: 'Form 4 issued' });
    await assert.rejects(lines.tick(DOC, id, 'body-handover', { state: 'done', receiver: { name: 'Suresh Kumar', relationship: 'Son' } }), ForbiddenException);
    for (const receiver of [undefined, {}, { name: 'Suresh Kumar' }, { name: ' ', relationship: 'Son' }, { name: 'x'.repeat(101), relationship: 'Son' }]) {
      await assert.rejects(lines.tick(NURSE, id, 'body-handover', { state: 'done', receiver: receiver as any }), BadRequestException, JSON.stringify(receiver));
    }
    await assert.rejects(lines.tick(NURSE, id, 'teaching', { state: 'done' }), BadRequestException, 'not on a death checklist');
    await assert.rejects(lines.tick(DOC, id, 'death-certificate', { state: 'done', receiver: { name: 'x', relationship: 'y' } }), BadRequestException);
    assert.equal((await stored(id)).state, 'ordered');

    await lines.tick(NURSE, id, 'body-handover', { state: 'done', receiver: { name: ' Suresh Kumar ', relationship: 'Son' } });
    const row = await stored(id);
    assert.deepEqual(row.bodyReceiver, { name: 'Suresh Kumar', relationship: 'Son' });
    // A body is never held for the bill.
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹4,200 due']);
    assert.deepEqual(keyStates(row.lines), [['order', 'done'], ['summary', 'done'], ['death-certificate', 'done'], ['body-handover', 'done'], ['bill', 'waiting']]);
    assert.equal(row.state, 'ready');
    const [ready] = await w.sent('discharge.ready');
    assert.deepEqual([ready.summary, ready.payload.kind], [`${BED}: Ready to leave (Died)`, 'died']);
  });

  // ---------- Messages ----------

  test('ready is announced once, and again after it was lost and regained within 60 s', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const b = await bill({ state: 'final', totals: totals(1000, 1000) });
    await sign(o._id);
    await lines.refresh(id);
    assert.deepEqual([(await stored(id)).state, missing(await stored(id))], ['ordered', ['teaching']]);

    await lines.tick(NURSE, id, 'teaching', { state: 'done', note: 'Warning signs explained to his son' });
    let row = await stored(id);
    assert.deepEqual([row.state, row.readyCount, (await planOf()).state], ['ready', 1, 'ready']);
    let ready = await w.sent('discharge.ready');
    assert.equal(ready.length, 1);
    assert.deepEqual([String(ready[0].case), ready[0].summary, ready[0].payload, ready[0].dedupeKey], [
      caseId, `${BED}: Ready to leave (Home)`, { orderId: id, bedLabel: BED, kind: 'home' }, `discharge.ready:${id}:1`,
    ]);
    assert.ok(row.announced.includes('discharge.ready'));
    // Refreshed again, and twice at once: still announced once.
    await lines.refresh(id);
    await Promise.all([lines.refresh(id), lines.refresh(id)]);
    assert.equal((await w.sent('discharge.ready')).length, 1);

    // A late charge: Ready is lost, and the plan with it.
    await m.Bill.updateOne({ _id: b._id }, { $set: { totals: totals(1300, 1000) } });
    await lines.refresh(id);
    row = await stored(id);
    assert.deepEqual([row.state, (await planOf()).state, row.announced.includes('discharge.ready')], ['ordered', 'ordered', false]);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹300 due']);

    // Paid within the minute, seen by two refreshes at once: Ready again, announced once more under the next key.
    await m.Bill.updateOne({ _id: b._id }, { $set: { totals: totals(1300, 1300) } });
    await Promise.all([lines.refresh(id), lines.refresh(id)]);
    ready = await w.sent('discharge.ready');
    assert.deepEqual(ready.map((r) => r.dedupeKey), [`discharge.ready:${id}:1`, `discharge.ready:${id}:2`]);
    row = await stored(id);
    assert.deepEqual([row.state, row.readyCount, (await planOf()).state, row.announced.includes('discharge.ready')], ['ready', 2, 'ready', true]);
    assert.deepEqual(logged, []);
  });

  test('R5: the summary line follows the signature, and the order line is done from the start', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    let row = await stored(id);
    assert.deepEqual([row.lines[0].key, row.lines[0].state, row.lines[0].by, row.lines[0].at.getTime()], ['order', 'done', { id: DOC.id, name: DOC.name }, NOW.getTime()]);
    assert.deepEqual(await stateOf(id, 'summary'), ['waiting', undefined]);

    const s = await sign(o._id);
    await lines.refresh(id);
    let line = await lineOf(id, 'summary');
    assert.deepEqual([line.state, line.by, line.at?.getTime()], ['done', { id: DOC.id, name: DOC.name }, SIGNED.getTime()]);
    // Edit and re-sign unlocks it (the signed version is kept): waiting again until it is signed again.
    await m.DischargeSummary.updateOne(
      { _id: s._id },
      { $push: { versions: { sections: {}, course: { text: 'Treated with antibiotics.', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: SIGNED } }, $unset: { signedAt: 1, signedBy: 1 } },
    );
    await lines.refresh(id);
    line = await lineOf(id, 'summary');
    assert.deepEqual([line.state, line.detail, line.by, line.at], ['waiting', 'Unlocked: sign it again', undefined, undefined]);
    await m.DischargeSummary.updateOne({ _id: s._id }, { $set: { signedAt: at(26, 12), signedBy: { id: ADMIN.id, name: ADMIN.name } } });
    await lines.refresh(id);
    line = await lineOf(id, 'summary');
    assert.deepEqual([line.state, line.detail, line.by, line.at?.getTime()], ['done', undefined, { id: ADMIN.id, name: ADMIN.name }, at(26, 12).getTime()]);

    // A required line lost from the record comes back: the order line done by the ordering doctor, a hand line waiting.
    await m.DischargeOrder.updateOne({ _id: o._id }, { $pull: { lines: { key: { $in: ['order', 'teaching'] } } } });
    await lines.refresh(id);
    row = await stored(id);
    assert.deepEqual(keyStates(row.lines), [
      ['order', 'done'], ['summary', 'done'], ['lab', 'done'], ['take-home', 'not-needed'], ['follow-up', 'not-needed'], ['teaching', 'waiting'], ['bill', 'needs-person'],
    ]);
    assert.deepEqual([row.lines[0].by, row.lines[0].at?.getTime()], [{ id: DOC.id, name: DOC.name }, NOW.getTime()]);
  });

  test('a tick that lands while a refresh is reading is never undone by it', async () => {
    const o = await orders.order(DOC, planId, homeNone({ takeHome: { lines: [pantoprazole40] } }));
    const id = String(o._id);
    assert.deepEqual(await stateOf(id, 'take-home'), ['waiting', '1 medicine waiting in Pharmacy']);
    await m.PharmacyLine.updateMany({ order: o.takeHomeOrder }, { $set: { status: 'issued' } });
    // The refresh has read the order and worked out "done"; the doctor's "not needed" lands before it writes.
    const wanted = (lines as any).wanted.bind(lines);
    let once = true;
    (lines as any).wanted = async (order: unknown, onCase: unknown) => {
      const out = await wanted(order, onCase);
      if (once) {
        once = false;
        await lines.tick(DOC, id, 'take-home', { state: 'not-needed', note: 'He has these at home' });
      }
      return out;
    };
    await lines.refresh(id);
    const line = await lineOf(id, 'take-home');
    assert.deepEqual([line.state, line.by?.name, line.note], ['not-needed', DOC.name, 'He has these at home']);
    assert.equal((await stored(id)).noTakeHome, true);
  });

  test('a cancelled order keeps its lines: refresh, ticks, follow up later and the override leave it alone', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const { requestId } = await labRequest([{ test: 'urine', status: 'received' }]);
    await orders.cancel(DOC, id, 'Spiked a fever again');
    const before = await stored(id);
    await lines.refresh(id);
    await assert.rejects(lines.tick(NURSE, id, 'teaching', { state: 'done' }), ConflictException);
    await assert.rejects(lines.followUpLater(DOC, id, requestId), ConflictException);
    await assert.rejects(lines.overrideBill(ADMIN, id, 'Billed on paper'), ConflictException);
    await assert.rejects(lines.refresh(String(new Types.ObjectId())), NotFoundException);
    const after = await stored(id);
    assert.deepEqual([after.state, after.lines, after.followUpLater], ['cancelled', before.lines, []]);
  });

  test('missing lists the required lines not done, in order; optional and shown lines never block', () => {
    const l = (key: any, state: any): DischargeLineEntry => ({ key, state });
    const home = [l('order', 'done'), l('summary', 'waiting'), l('lab', 'done'), l('take-home', 'not-needed'), l('follow-up', 'done'), l('teaching', 'waiting'), l('bill', 'needs-person')];
    assert.deepEqual(missing({ kind: 'home', lines: home }), ['summary', 'teaching', 'bill']);
    assert.equal(isReady({ kind: 'home', lines: home }), false);
    // A required line that isn't there at all is missing too.
    assert.deepEqual(missing({ kind: 'home', lines: [] }), ['order', 'summary', 'lab', 'take-home', 'follow-up', 'teaching', 'bill']);
    // Transfer and Died: the bill is shown and never blocks.
    assert.equal(isReady({ kind: 'transfer', lines: [l('order', 'done'), l('summary', 'done'), l('lab', 'done'), l('take-home', 'not-needed'), l('teaching', 'done'), l('bill', 'waiting')] }), true);
    assert.equal(isReady({ kind: 'died', lines: [l('order', 'done'), l('summary', 'done'), l('death-certificate', 'done'), l('body-handover', 'done'), l('bill', 'needs-person')] }), true);
    // Against advice: take-home and follow-up are optional; the form and the bill are required.
    const ama = [l('order', 'done'), l('summary', 'done'), l('take-home', 'waiting'), l('follow-up', 'waiting'), l('ama-form', 'done'), l('teaching', 'done'), l('bill', 'waiting')];
    assert.deepEqual(missing({ kind: 'against-advice', lines: ama }), ['bill']);
    assert.equal(lines.isReady({ kind: 'against-advice', lines: ama }), false);
    assert.deepEqual(lines.missing({ kind: 'against-advice', lines: ama }), ['bill']);
  });

  // ---------- Wake handlers ----------

  test('wake: Lab, Pharmacy and Scheduling messages refresh the stay; a caseless one is ignored', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const seen: string[] = [];
    const real = lines.refresh.bind(lines);
    lines.refresh = async (orderId: string) => {
      seen.push(orderId);
      return real(orderId);
    };
    const message = (type: string, onCase: unknown) =>
      m.AgentMessage.create({
        case: onCase, from: type.split('.')[0], to: ['coordinator'], type, priority: 'medium', summary: 'x', payload: {}, dedupeKey: `${type}:${new Types.ObjectId()}`,
      });
    // Every wake type has a handler: the plans service holds the bed ones, this one the rest.
    assert.deepEqual(WAKE_TYPES.filter((t) => !reg.wake.has(t)), []);
    const types = WAKE_TYPES.filter((t) => !t.startsWith('bed.') && !t.startsWith('revenue.'));
    assert.deepEqual(types, [
      'lab.resulted', 'lab.cancelled', 'lab.critical', 'lab.critical-acked',
      'pharmacy.issued', 'pharmacy.cancelled', 'pharmacy.stopped', 'pharmacy.rejected', 'scheduling.followup-booked',
    ]);
    for (const type of types) {
      seen.length = 0;
      await reg.wake.get(type)!(String((await message(type, caseId))._id));
      assert.deepEqual(seen, [id], type);
      seen.length = 0;
      await reg.wake.get(type)!(String((await message(type, null))._id));
      assert.deepEqual(seen, [], `${type} with no case`);
    }
    // Another patient's case never wakes this stay.
    const mary = await another('MHK202600902', 'Mary Jeni');
    seen.length = 0;
    await reg.wake.get('lab.resulted')!(String((await message('lab.resulted', mary.caseId))._id));
    assert.deepEqual(seen, []);
    // R24: an order with no case of its own is found through its patient.
    await m.DischargeOrder.updateOne({ _id: o._id }, { $unset: { case: 1 } });
    await reg.wake.get('pharmacy.issued')!(String((await message('pharmacy.issued', caseId))._id));
    assert.deepEqual(seen, [id]);
    assert.deepEqual(logged, []);

    // A message that is gone, or a refresh that fails: logged, never thrown.
    await reg.wake.get('lab.resulted')!(String(new Types.ObjectId()));
    lines.refresh = async () => {
      throw new Error('database down');
    };
    await reg.wake.get('lab.critical-acked')!(String((await message('lab.critical-acked', caseId))._id));
    assert.equal(logged.length, 2, logged.join(' | '));
    assert.match(logged[1], /database down/);
  });

  test('wake: a walk-in bill settling is a quiet no-op; an admission bill of an open order refreshes it', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    const seen: string[] = [];
    const real = lines.refresh.bind(lines);
    lines.refresh = async (orderId: string) => {
      seen.push(orderId);
      return real(orderId);
    };
    // The kiosk settles walk-in bills all day; OPD bills settle with their visit. Neither is a stay's bill.
    const walkIn = await bill({ kind: 'walk-in', admission: undefined, day: '2026-09-26', state: 'settled', totals: totals(300, 300) });
    await revenue('revenue.bill-settled', walkIn, { total: 300 });
    const opd = await bill({ kind: 'opd', admission: undefined, day: '2026-09-26', appointment: new Types.ObjectId(), state: 'final', totals: totals(300, 300) });
    await revenue('revenue.bill-final', opd, { balance: 0 });
    // A bill id that matches nothing, or is no id at all.
    await revenue('revenue.bill-settled', { _id: new Types.ObjectId(), number: 'BL-9999', case: caseId }, { total: 0 });
    await revenue('revenue.bill-settled', { _id: 'nope', number: 'BL-9998', case: caseId }, { total: 0 });
    // An admission bill of another stay whose order was cancelled: nothing to refresh.
    const otherAdmission = new Types.ObjectId();
    await m.DischargeOrder.create({
      plan: new Types.ObjectId(), admission: otherAdmission, patient: w.patientId, kind: 'home', state: 'cancelled', plannedLeaveAt: NOW, windowAt: NOW,
      diagnosis: DIAGNOSIS, orderedBy: { id: DOC.id, name: DOC.name }, orderedAt: NOW,
    });
    const old = await bill({ admission: otherAdmission, state: 'settled', totals: totals(100, 100) });
    await revenue('revenue.bill-settled', old, { total: 100 });
    assert.deepEqual(seen, []);
    assert.deepEqual(logged, [], 'quietly');

    // This stay's admission bill: its open order is refreshed.
    const b = await bill({ state: 'final', totals: totals(800, 800) });
    await revenue('revenue.bill-final', b, { balance: 0 });
    assert.deepEqual(seen, [id]);
    assert.deepEqual(await stateOf(id, 'bill'), ['done', 'Final bill ready: nothing due']);
    assert.equal(await lines.refreshAdmission(admissionId), 1);
    assert.equal(await lines.refreshAdmission(String(otherAdmission)), 0);
    assert.equal(await lines.refreshCase(caseId), 1);
    assert.equal(await lines.refreshCase('nope'), 0);
  });
});
