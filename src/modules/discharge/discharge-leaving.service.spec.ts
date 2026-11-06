import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { DOC, PHARM, World, amoxicillin500, buildWorld, pantoprazole40 } from '../../test/pharmacy-fixtures';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { BedEvents } from '../beds/bed-events';
import { BedsService } from '../beds/beds.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { RulesService } from '../coordinator/rules.service';
import { PatientsService } from '../patients/patients.service';
import { SchedulingFollowupsService } from '../scheduling/scheduling-followups.service';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLeavingService } from './discharge-leaving.service';
import { DischargeLinesService } from './discharge-lines.service';
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
const WARD = 'General ward A (men)';
/** A clinic-clock (local) moment in September 2026. */
const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min, 0, 0);
const NOW = at(26, 11);
const EVENING = at(26, 20);
const ADMITTED = at(24, 10);
const SIGNED = at(26, 11, 5);
const DIAGNOSIS = 'Community-acquired pneumonia, treated';
const HEADER = "St. Mary's Multi Speciality Hospital, Nagercoil";
const LWD_REASON = 'Not in bed at the 06:30 round; the family took him home';

describe('DischargeLeavingService', () => {
  const m = models();
  let w: World;
  let reg: DischargeRegistration;
  let settings: DischargeSettingsService;
  let lines: DischargeLinesService;
  let orders: DischargeOrdersService;
  let beds: BedsService;
  let leaving: DischargeLeavingService;
  let caseId: string;
  let planId: string;
  let admissionId: string;
  let bedId: string;
  let wardId: unknown;
  let seq: number;
  let savedClinic: string | undefined;
  let logged: string[];
  /** Every send the services asked for: the Coordinator drops a repeat within a minute, so stored messages can't show one. */
  let sends: { type: string; caseId: string | null; payload: Record<string, unknown>; summary: string }[];
  /** Run inside a send, just before it reaches the Coordinator, and just after: to force an interleaving. */
  let beforeForward: ((type: string) => Promise<void>) | null;
  let afterForward: ((type: string) => Promise<void>) | null;

  const sendsOf = (type: string) => sends.filter((s) => s.type === type);
  const stored = (id: unknown) => m.DischargeOrder.findById(id).lean<any>();
  const planOf = (id = planId) => m.DischargePlan.findById(id).lean<any>();
  const bedOf = (id = bedId) => m.Bed.findById(id).lean<any>();
  const admissionOf = (id = admissionId) => m.Admission.findById(id).lean<any>();
  const patientOf = (id = w.patientId) => m.Patient.findById(id).lean<any>();
  const clocksOf = (orderId: unknown) => m.Clock.find({ ref: String(orderId) }).sort({ def: 1 }).lean<any[]>();
  const stateOf = async (id: unknown, key: string) => {
    const l = (await stored(id)).lines.find((x: any) => x.key === key);
    return [l?.state, l?.detail];
  };
  const time = (d: unknown) => (d ? new Date(d as string).getTime() : d);
  const totals = (charges: number, payments: number, refunds = 0) => ({ charges, discounts: 0, payments, refunds, balance: charges - payments + refunds });
  /** An admission bill of the main stay unless `extra` says otherwise. */
  const bill = (extra: Record<string, unknown> = {}) =>
    m.Bill.create({
      number: `BL-${String(++seq).padStart(4, '0')}`, patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar',
      kind: 'admission', state: 'open', case: caseId, admission: admissionId, openedAt: NOW, totals: totals(0, 0), ...extra,
    });
  /** The order's summary, signed by Dr. Shajin (Task 10 signs through its own service). */
  const sign = (orderId: unknown, kind = 'home') =>
    m.DischargeSummary.create({ order: orderId, kind, course: { text: 'Treated with antibiotics.', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: SIGNED });
  /** A Home order for now + 1 h (its window opens at once) with nothing to take home and no follow-up. */
  const homeNone = (extra: Partial<OrderInput> = {}): OrderInput => ({
    kind: 'home', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'improved', takeHome: 'none', followUp: 'none', ...extra,
  });
  const transfer = (): OrderInput => ({
    kind: 'transfer', plannedLeaveAt: new Date(NOW.getTime() + 60 * MIN), diagnosis: DIAGNOSIS, condition: 'stable',
    receivingHospital: 'Government Medical College, Trivandrum', transferReason: 'Needs cardiac surgery', takeHome: 'none',
  });
  const died = (): OrderInput => ({ kind: 'died', diagnosis: 'Acute myocardial infarction', timeOfDeath: at(26, 10, 40), causeOfDeath: 'Cardiogenic shock' });
  /**
   * An order made Ready: the summary signed, the nurse's teaching ticked, and (by default) the stay's bill settled.
   * `billExtra: null` writes no bill. Returns the order id.
   */
  const ready = async (input: OrderInput = homeNone(), billExtra: Record<string, unknown> | null = { state: 'settled', totals: totals(4200, 4200) }, plan = planId) => {
    const o = await orders.order(DOC, plan, input);
    const id = String(o._id);
    if (billExtra) await bill(billExtra);
    await sign(o._id, input.kind);
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    const row = await stored(id);
    assert.equal(row.state, 'ready', JSON.stringify(row.lines.map((l: any) => [l.key, l.state])));
    return id;
  };
  /** A died order made Ready: the summary signed, the certificate and the body handover ticked. A bill may still be due. */
  const readyDied = async () => {
    const o = await orders.order(DOC, planId, died());
    const id = String(o._id);
    await sign(o._id, 'died');
    await lines.tick(DOC, id, 'death-certificate', { state: 'done' });
    await lines.tick(NURSE, id, 'body-handover', { state: 'done', receiver: { name: 'Suresh Kumar', relationship: 'Son' } });
    assert.equal((await stored(id)).state, 'ready');
    return id;
  };
  /** Another patient admitted to a bed of their own, with an open ward case and a plan. */
  const anotherStay = async (uhid: string, name: string, number: number) => {
    const p = await m.Patient.create({ uhid, name, age: 48, gender: 'Male', phone: '9100000077' });
    const onCase = String((await w.openWard(String(p._id), uhid, name)).case._id);
    const b = await m.Bed.create({ ward: wardId, label: `GWA-${number}`, number, state: 'occupied' });
    const a = await m.Admission.create({
      patient: p._id, patientUhid: uhid, patientName: name, bed: b._id, doctor: 'Dr. Shajin', department: 'General Medicine',
      roomClass: 'general', expectedStayDays: 2, admittedAt: ADMITTED, admittedBy: NURSE.name,
    });
    await m.Bed.updateOne({ _id: b._id }, { $set: { admission: a._id } });
    const plan = await m.DischargePlan.create({
      admission: a._id, case: onCase, patient: p._id, patientUhid: uhid, patientName: name, bedLabel: `GWA-${number}`, wardName: WARD,
      doctor: 'Dr. Shajin', targetDay: '2026-09-26', targetAt: at(26, 11), state: 'planned',
    });
    return { patientId: String(p._id), caseId: onCase, planId: String(plan._id), admissionId: String(a._id), bedId: String(b._id) };
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
    seq = 0;
    await resetTestDb();
    await m.HospitalSettings.create({ queue: { counters: ['Room 101'] } });
    w = await buildWorld(m, { stubDischarge: false });
    const settingsService = new SettingsService(m.HospitalSettings);
    settings = new DischargeSettingsService(settingsService);
    const rules = new RulesService(w.registry, settingsService, new CoordinatorEvents());
    reg = new DischargeRegistration(w.registry, w.messages, w.cases, settings, m.DischargePlan, m.DischargeOrder, m.Admission);
    logged = [];
    const logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
    (reg as any).logger = logger;
    reg.onModuleInit();
    sends = [];
    beforeForward = null;
    afterForward = null;
    const send = reg.send.bind(reg);
    reg.send = async (type, onCase, payload, summary, opts) => {
      sends.push({ type, caseId: onCase, payload, summary });
      await beforeForward?.(type);
      const went = await send(type, onCase, payload, summary, opts);
      await afterForward?.(type);
      return went;
    };
    const plans = new DischargePlansService(reg, w.messages, rules, settings, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Case, m.TaskAlertItem, m.Patient);
    (plans as any).logger = logger;
    beds = new BedsService(m.Ward, m.Bed, m.Admission, new PatientsService(m.Patient), new BedEvents(), m.DischargeOrder);
    lines = new DischargeLinesService(
      reg, w.messages, w.cases, m.DischargeOrder, m.DischargePlan, m.DischargeSummary, m.LabRequest, m.LabLine, m.PharmacyLine, m.FollowUpItem, m.Bill, m.ChargeLine,
    );
    (lines as any).logger = logger;
    lines.clock = () => NOW;
    // These orders take no follow-up, and the summary has its own spec: the tests write the summary records themselves.
    const noFollowUps = {} as SchedulingFollowupsService;
    const noSummary = { draft: async () => null, archiveForCancel: async () => false } as unknown as DischargeSummaryService;
    orders = new DischargeOrdersService(
      reg, plans, settings, w.cases, beds, w.takeHome, noFollowUps, lines, noSummary, m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.PharmacyLine,
    );
    (orders as any).logger = logger;
    orders.clock = () => NOW;
    leaving = new DischargeLeavingService(reg, plans, orders, lines, settings, beds, w.escalations, m.DischargePlan, m.DischargeOrder, m.Admission, m.Bill, m.CoordinatorCounter);
    (leaving as any).logger = logger;
    leaving.clock = () => NOW;

    caseId = String((await w.openWard()).case._id);
    const ward = await m.Ward.create({ code: 'GWA', name: WARD, shortName: 'Ward A', floor: 1, type: 'general', gender: 'male', ratePerDay: 800 });
    wardId = ward._id;
    const b = await m.Bed.create({ ward: ward._id, label: BED, number: 12, state: 'occupied' });
    bedId = String(b._id);
    const a = await m.Admission.create({
      patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar', bed: b._id, doctor: 'Dr. Shajin', department: 'General Medicine',
      roomClass: 'general', expectedStayDays: 2, admittedAt: ADMITTED, admittedBy: NURSE.name,
    });
    admissionId = String(a._id);
    await m.Bed.updateOne({ _id: b._id }, { $set: { admission: a._id } });
    await w.cases.addRefs(caseId, { admissionId });
    const plan = await m.DischargePlan.create({
      admission: a._id, case: caseId, patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar', bedLabel: BED, wardName: WARD,
      doctor: 'Dr. Shajin', targetDay: '2026-09-26', targetAt: at(26, 11), state: 'planned',
    });
    planId = String(plan._id);
  });
  afterEach(() => {
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  // ---------- The gate pass ----------

  test('gate pass before Ready is 409', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    await assert.rejects(leaving.gatePass(NURSE, id), (e: unknown) => {
      assert.ok(e instanceof ConflictException, String(e));
      assert.equal((e as ConflictException).message, "The checklist isn't finished: Summary signed, Teaching and documents, Nothing due on the bill");
      return true;
    });
    // A bill with something due still holds it, however much else is done.
    await sign(o._id);
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    await bill({ state: 'final', totals: totals(4200, 3000) });
    await assert.rejects(leaving.gatePass(DESK, id), (e: unknown) => {
      assert.equal((e as ConflictException).message, "The checklist isn't finished: Nothing due on the bill");
      return true;
    });
    assert.equal((await stored(id)).gatePass, undefined);
    assert.equal(await m.CoordinatorCounter.countDocuments({ key: 'discharge-gatepass' }), 0, 'no number is taken');
    // Only a nurse, the front desk or an admin prints it.
    for (const who of [DOC, PHARM, LAB]) await assert.rejects(leaving.gatePass(who, id), ForbiddenException, who.name);
    await assert.rejects(leaving.gatePass(NURSE, String(new Types.ObjectId())), NotFoundException);
    await assert.rejects(leaving.gatePass(NURSE, 'not-an-id'), NotFoundException);
  });

  test('the first print takes GP-0001, a reprint keeps it and says reprint', async () => {
    await settings.save(ADMIN, { gatePassHeader: HEADER });
    const id = await ready();
    leaving.clock = () => at(26, 11, 20);
    const first = await leaving.gatePass(NURSE, id);
    assert.deepEqual({ ...first, admittedAt: time(first.admittedAt), plannedLeaveAt: time(first.plannedLeaveAt), issuedAt: time(first.issuedAt) }, {
      number: 'GP-0001',
      reprint: false,
      patient: { name: 'Ravi Kumar', uhid: w.patientUhid },
      bedLabel: BED,
      admittedAt: ADMITTED.getTime(),
      plannedLeaveAt: NOW.getTime() + 60 * MIN,
      billLine: 'Bill settled: BL-0001',
      issuedBy: NURSE.name,
      issuedAt: at(26, 11, 20).getTime(),
      header: HEADER,
    });
    let row = await stored(id);
    assert.deepEqual([row.gatePass.number, row.gatePass.by, row.gatePass.printedAt.map(time)], ['GP-0001', { id: NURSE.id, name: NURSE.name }, [at(26, 11, 20).getTime()]]);

    // A reprint by the desk: the same number, issuer and time, marked REPRINT; each print is recorded.
    leaving.clock = () => at(26, 11, 40);
    const again = await leaving.gatePass(DESK, id);
    assert.deepEqual([again.number, again.reprint, again.issuedBy, time(again.issuedAt), again.billLine], ['GP-0001', true, NURSE.name, at(26, 11, 20).getTime(), 'Bill settled: BL-0001']);
    row = await stored(id);
    assert.deepEqual(row.gatePass.printedAt.map(time), [at(26, 11, 20).getTime(), at(26, 11, 40).getTime()]);
    assert.deepEqual(row.gatePass.by, { id: NURSE.id, name: NURSE.name });

    // The next stay's first pass takes the next number.
    const other = await anotherStay('MHK202600907', 'Mary Jeni', 14);
    const o2 = await orders.order(DOC, other.planId, homeNone());
    await m.Bill.create({
      number: 'BL-0101', patient: other.patientId, patientUhid: 'MHK202600907', patientName: 'Mary Jeni', kind: 'admission', state: 'settled', case: other.caseId,
      admission: other.admissionId, openedAt: NOW, totals: totals(900, 900),
    });
    await sign(o2._id);
    await lines.tick(NURSE, String(o2._id), 'teaching', { state: 'done' });
    const second = await leaving.gatePass(ADMIN, String(o2._id));
    assert.deepEqual([second.number, second.reprint, second.patient, second.bedLabel, second.billLine], ['GP-0002', false, { name: 'Mary Jeni', uhid: 'MHK202600907' }, 'GWA-14', 'Bill settled: BL-0101']);
  });

  test('the bill line on the pass follows the stay\'s bills: balance due on a transfer, a refund owed, nothing due, settled', async () => {
    const o = await orders.order(DOC, planId, transfer());
    const id = String(o._id);
    const b = await bill({ totals: totals(6000, 2000) });
    await sign(o._id, 'transfer');
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    // A transfer never waits for the bill: the pass prints, and says billing knows.
    assert.equal((await stored(id)).state, 'ready');
    const pass = await leaving.gatePass(NURSE, id);
    assert.deepEqual([pass.number, pass.billLine], ['GP-0001', 'Balance due: billing informed']);
    // The final bill over-collected: a refund owed is the hospital's money, never the patient's.
    await m.Bill.updateOne({ _id: b._id }, { $set: { state: 'final', totals: totals(6000, 6500) } });
    assert.equal((await leaving.gatePass(NURSE, id)).billLine, 'Refund due: billing informed');
    // Final with nothing due, not settled yet; then settled.
    await m.Bill.updateOne({ _id: b._id }, { $set: { totals: totals(6000, 6000) } });
    assert.equal((await leaving.gatePass(NURSE, id)).billLine, 'Nothing due: BL-0001');
    await m.Bill.updateOne({ _id: b._id }, { $set: { state: 'settled' } });
    assert.equal((await leaving.gatePass(NURSE, id)).billLine, 'Bill settled: BL-0001');
    const passes = (await stored(id)).gatePass;
    assert.deepEqual([passes.number, passes.printedAt.length], ['GP-0001', 4]);
    // No name anywhere but the patient block.
    assert.ok(!/Ravi/.test(JSON.stringify({ ...pass, patient: null })));
  });

  // ---------- Patient left ----------

  test('left without a gate pass is 409', async () => {
    const id = await ready();
    await assert.rejects(leaving.left(NURSE, id), (e: unknown) => {
      assert.ok(e instanceof ConflictException, String(e));
      assert.equal((e as ConflictException).message, 'Print the gate pass first.');
      return true;
    });
    for (const who of [DOC, PHARM, LAB]) await assert.rejects(leaving.left(who, id), ForbiddenException, who.name);
    const row = await stored(id);
    assert.deepEqual([row.state, row.leftAt, row.endedAs], ['ready', undefined, undefined]);
    assert.equal((await bedOf()).state, 'occupied');
    assert.equal((await admissionOf()).status, 'active');
    assert.equal(sendsOf('discharge.completed').length, 0);
  });

  test('two lefts at once end the stay once', async () => {
    const id = await ready();
    await leaving.gatePass(NURSE, id);
    const results = await Promise.allSettled([leaving.left(NURSE, id), leaving.left(DESK, id)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof ConflictException, String(lost.reason));
    assert.equal(sendsOf('discharge.completed').length, 1);
    assert.equal((await w.sent('discharge.completed')).length, 1);
    const adm = await admissionOf();
    assert.equal(adm.status, 'discharged');
    assert.equal((await bedOf()).state, 'cleaning');
    assert.equal((await stored(id)).state, 'left');
    // And again later: the patient has already left.
    await assert.rejects(leaving.left(NURSE, id), /The patient has already left\./);
    await assert.rejects(leaving.gatePass(NURSE, id), /The patient has already left\./);
    assert.deepEqual(logged, []);
  });

  test('a continuation bill due after the gate pass makes left 409', async () => {
    const id = await ready();
    await leaving.gatePass(NURSE, id);
    // A take-home medicine issued after settlement opened a continuation bill; Revenue sends no message for that charge.
    const continuation = await bill({ totals: totals(240, 0) });
    await assert.rejects(leaving.left(NURSE, id), (e: unknown) => {
      assert.ok(e instanceof ConflictException, String(e));
      assert.equal((e as ConflictException).message, 'Something changed on the checklist: Nothing due on the bill');
      return true;
    });
    const row = await stored(id);
    assert.deepEqual([row.state, row.leftAt, row.endedAs], ['ordered', undefined, undefined]);
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹240 due']);
    assert.equal((await planOf()).state, 'ordered');
    assert.equal((await bedOf()).state, 'occupied');
    assert.equal((await admissionOf()).status, 'active');
    assert.equal(sendsOf('discharge.completed').length, 0);
    // A reprint waits too: the pass never prints while money is owed.
    await assert.rejects(leaving.gatePass(NURSE, id), ConflictException);
    // Paid and settled: Ready again, and the printed pass lets the patient go.
    await m.Bill.updateOne({ _id: continuation._id }, { $set: { state: 'settled', totals: totals(240, 240) } });
    await leaving.left(NURSE, id);
    assert.equal((await stored(id)).state, 'left');
  });

  test('left ends the stay, the patient is Discharged, the bed cleaning, the plan completed, the clocks stopped and the waiting ward lines cancelled by Pharmacy', async () => {
    const reminder = `discharge-plan:${planId}:reminder`;
    // A ward medicine still waiting for the pharmacist's check, on the stay's case.
    const ward = await w.orders.order(DOC, { patientId: w.patientId, priority: 'routine', lines: [amoxicillin500] });
    assert.deepEqual([ward.caseId, ward.setting], [caseId, 'Ward']);
    const [wardLine] = await m.PharmacyLine.find({ order: ward.id }).lean<any[]>();
    assert.equal(wardLine.status, 'to-check');
    const id = await ready();
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'running']]);
    await m.TaskAlertItem.create({ title: `Discharge due today, no order yet: ${BED}`, type: 'System', category: 'Follow-up', priority: 'Medium', status: 'Pending', link: reminder });
    await leaving.gatePass(NURSE, id);
    const leftAt = at(26, 12, 15);
    leaving.clock = () => leftAt;

    const result = await leaving.left(DESK, id);
    assert.equal(String(result._id), id);
    const row = await stored(id);
    assert.deepEqual([row.state, time(row.leftAt), row.leftBy, row.endedAs], ['left', leftAt.getTime(), { id: DESK.id, name: DESK.name }, 'home']);
    assert.ok(row.announced.includes('discharge.completed'), row.announced.join(', '));
    // The stay ends through the Bed Agent: the admission discharged now, the bed to cleaning, the patient Discharged.
    const adm = await admissionOf();
    assert.deepEqual([adm.status, time(adm.dischargedAt), adm.dischargedBy], ['discharged', leftAt.getTime(), DESK.name]);
    const bed = await bedOf();
    assert.deepEqual([bed.state, bed.admission], ['cleaning', null]);
    assert.equal((await patientOf()).status, 'Discharged');
    // The plan is completed with the kind, and any reminder closed.
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.completedKind, time(plan.completedAt), String(plan.order)], ['completed', 'home', leftAt.getTime(), id]);
    assert.equal((await m.TaskAlertItem.findOne({ link: reminder }).lean<any>()).status, 'Completed');
    // discharge.completed on the case, naming the bed and the kind, never the patient; it stops both clocks.
    const [done] = await w.sent('discharge.completed');
    assert.deepEqual([String(done.case), done.summary], [caseId, `${BED}: Patient left (Home)`]);
    assert.deepEqual({ ...done.payload, leftAt: time(done.payload.leftAt) }, { planId, orderId: id, admissionId, bedLabel: BED, kind: 'home', leftAt: leftAt.getTime() });
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'met'], ['discharge-summary', 'met']]);
    // Pharmacy cancels the ward medicine still waiting (A12).
    const cancelled = await m.PharmacyLine.findById(wardLine._id).lean<any>();
    assert.deepEqual([cancelled.status, cancelled.cancelled?.reason], ['cancelled', 'Patient discharged']);
    // R21: a discharge that left 75 minutes after its window is on time today.
    reg.clock = () => leftAt;
    assert.equal((await (reg as any).status()).onTimePct, 100);
    assert.deepEqual(logged, []);
  });

  test('a bed that cannot be freed puts the order back and reports the error', async () => {
    const id = await ready();
    await leaving.gatePass(NURSE, id);
    // The bed no longer holds this stay (a transfer got there first).
    await m.Bed.updateOne({ _id: bedId }, { $set: { admission: new Types.ObjectId() } });
    await assert.rejects(leaving.left(NURSE, id), ConflictException);
    let row = await stored(id);
    assert.deepEqual([row.state, row.leftAt, row.leftBy, row.endedAs], ['ready', undefined, undefined, undefined]);
    assert.equal((await planOf()).state, 'ready');
    assert.equal((await admissionOf()).status, 'active');
    assert.equal(sendsOf('discharge.completed').length, 0);
    // Left without discharge fails the same way: nothing it changed stays.
    await assert.rejects(leaving.leftWithoutDischarge(NURSE, planId, { reason: 'Absconded', lastSeenAt: at(26, 10) }), ConflictException);
    row = await stored(id);
    assert.deepEqual([row.state, row.endedAs], ['ready', undefined]);
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.leftWithoutDischarge, plan.completedKind], ['ready', undefined, undefined]);
    assert.equal(await m.Escalation.countDocuments(), 0);
    assert.equal(sendsOf('discharge.completed').length, 0);
  });

  test('I1: a Patient left that lands while the window opens leaves discharge.completed due again', async () => {
    orders.clock = () => EVENING;
    leaving.clock = () => at(27, 7, 59);
    const id = await ready({ ...homeNone(), plannedLeaveAt: at(27, 10) });
    assert.equal((await stored(id)).windowOpenedAt, undefined, 'the window opens at 08:00 tomorrow');
    await leaving.gatePass(NURSE, id);
    // The patient leaves after the window is claimed and before window-opened reaches the Coordinator: the stop goes first.
    beforeForward = async (type) => {
      if (type !== 'discharge.window-opened') return;
      beforeForward = null;
      await leaving.left(NURSE, id);
    };
    assert.equal(await orders.openDueWindows(at(27, 8)), 1);
    const row = await stored(id);
    assert.equal(row.state, 'left');
    const order = await m.AgentMessage.find({ type: { $in: ['discharge.completed', 'discharge.window-opened'] } }).sort({ createdAt: 1, _id: 1 }).lean<any[]>();
    assert.deepEqual(order.map((x) => x.type), ['discharge.completed', 'discharge.window-opened']);
    // The late start opened a clock the earlier stop could not stop (the summary was signed before the window, so only
    // the leave clock runs), and the record says the stop is due again.
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running']]);
    assert.ok(row.announced.includes('discharge.window-opened'));
    assert.ok(!row.announced.includes('discharge.completed'), row.announced.join(', '));
    assert.ok(logged.some((l) => /left while its window was opening/.test(l)), logged.join(' | '));
    // Sent again by the one-minute pass (after the Coordinator's 60 s dedupe), it stops them.
    const [first] = await w.sent('discharge.completed');
    await w.messages.send({
      case: caseId, from: 'discharge', to: ['coordinator'], type: 'discharge.completed', priority: 'medium', summary: first.summary,
      payload: first.payload, dedupeKey: `discharge.completed:${id}:again`,
    });
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'met']]);
  });

  test('I1: the stop is due again also when Patient left finishes after the window opened', async () => {
    orders.clock = () => EVENING;
    leaving.clock = () => at(27, 7, 59);
    const id = await ready({ ...homeNone(), plannedLeaveAt: at(27, 10) });
    await leaving.gatePass(NURSE, id);
    let completedStored!: () => void;
    const isStored = new Promise<void>((resolve) => (completedStored = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let leavingNow: Promise<unknown> | null = null;
    // discharge.completed is stored first, then window-opened, and only then does Patient left record its own message:
    // the window's own check finds nothing to take back, so only the leaving side can leave the stop due again.
    beforeForward = async (type) => {
      if (type !== 'discharge.window-opened') return;
      beforeForward = null;
      leavingNow = leaving.left(NURSE, id);
      await isStored;
    };
    afterForward = async (type) => {
      if (type !== 'discharge.completed') return;
      afterForward = null;
      completedStored();
      await gate;
    };
    assert.equal(await orders.openDueWindows(at(27, 8)), 1);
    release();
    await leavingNow;
    const row = await stored(id);
    assert.equal(row.state, 'left');
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running']]);
    assert.ok(row.announced.includes('discharge.window-opened'));
    assert.ok(!row.announced.includes('discharge.completed'), row.announced.join(', '));
  });

  // ---------- Body released ----------

  test('body released for Died with a bill due ends the stay and sets Deceased', async () => {
    const o = await orders.order(DOC, planId, died());
    const id = String(o._id);
    const b = await bill({ totals: totals(4200, 0) });
    // A death has no gate pass, and Patient left is not its door; Body released is only for a death.
    await assert.rejects(leaving.gatePass(NURSE, id), BadRequestException);
    await assert.rejects(leaving.left(NURSE, id), BadRequestException);
    await assert.rejects(leaving.bodyReleased(NURSE, id), (e: unknown) => {
      assert.ok(e instanceof ConflictException, String(e));
      assert.equal((e as ConflictException).message, "The checklist isn't finished: Summary signed, Cause-of-death certificate, Body handed over");
      return true;
    });
    await sign(o._id, 'died');
    await lines.tick(DOC, id, 'death-certificate', { state: 'done' });
    await lines.tick(NURSE, id, 'body-handover', { state: 'done', receiver: { name: 'Suresh Kumar', relationship: 'Son' } });
    // A body is never held for the bill.
    assert.deepEqual(await stateOf(id, 'bill'), ['waiting', '₹4,200 due']);
    assert.equal((await stored(id)).state, 'ready');
    for (const who of [DOC, PHARM, LAB]) await assert.rejects(leaving.bodyReleased(who, id), ForbiddenException, who.name);
    const released = at(26, 11, 30);
    leaving.clock = () => released;

    await leaving.bodyReleased(DESK, id);
    const row = await stored(id);
    assert.deepEqual([row.state, time(row.leftAt), row.leftBy, row.endedAs], ['left', released.getTime(), { id: DESK.id, name: DESK.name }, 'died']);
    assert.equal((await patientOf()).status, 'Deceased');
    const adm = await admissionOf();
    assert.deepEqual([adm.status, time(adm.dischargedAt)], ['discharged', released.getTime()]);
    assert.equal((await bedOf()).state, 'cleaning');
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.completedKind, time(plan.completedAt)], ['completed', 'died', released.getTime()]);
    // The bill stays a Revenue task, untouched.
    const after = await m.Bill.findById(b._id).lean<any>();
    assert.deepEqual([after.state, after.totals.balance], ['open', 4200]);
    const [done] = await w.sent('discharge.completed');
    assert.deepEqual([done.summary, done.payload.kind, done.payload.orderId], [`${BED}: Body released (Died)`, 'died', id]);
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['met', 'met']);
    await assert.rejects(leaving.bodyReleased(DESK, id), /The patient has already left\./);

    // Body released is not for a living patient.
    const other = await anotherStay('MHK202600908', 'Joseph Raj', 15);
    const home = await orders.order(DOC, other.planId, homeNone());
    await assert.rejects(leaving.bodyReleased(NURSE, String(home._id)), BadRequestException);
  });

  // ---------- Left without discharge ----------

  test('left without discharge stops bed days at lastSeenAt, sets the status, raises the escalation and needs a reason', async () => {
    const reminder = `discharge-plan:${planId}:reminder`;
    await m.TaskAlertItem.create({ title: `Discharge due today, no order yet: ${BED}`, type: 'System', category: 'Follow-up', priority: 'Medium', status: 'Pending', link: reminder });
    const recorded = at(26, 9);
    const lastSeen = at(26, 6, 30);
    leaving.clock = () => recorded;
    const bad: unknown[] = [
      { reason: '', lastSeenAt: lastSeen },
      { reason: '   ', lastSeenAt: lastSeen },
      { reason: 'x'.repeat(301), lastSeenAt: lastSeen },
      { lastSeenAt: lastSeen },
      { reason: 'Absconded' },
      { reason: 'Absconded', lastSeenAt: 'not a date' },
      { reason: 'Absconded', lastSeenAt: at(26, 9, 1) },
      { reason: 'Absconded', lastSeenAt: at(24, 9, 59) },
      null,
    ];
    for (const input of bad) await assert.rejects(leaving.leftWithoutDischarge(NURSE, planId, input as any), BadRequestException, JSON.stringify(input));
    assert.equal((await planOf()).state, 'planned');
    assert.equal((await bedOf()).state, 'occupied');
    assert.equal(await m.Escalation.countDocuments(), 0);
    await assert.rejects(leaving.leftWithoutDischarge(NURSE, String(new Types.ObjectId()), { reason: 'Absconded', lastSeenAt: lastSeen }), NotFoundException);

    const result = await leaving.leftWithoutDischarge(NURSE, planId, { reason: `  ${LWD_REASON}  `, lastSeenAt: lastSeen.toISOString() });
    assert.equal(String(result._id), planId);
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.completedKind, time(plan.completedAt)], ['completed', 'left-without-discharge', lastSeen.getTime()]);
    const record = plan.leftWithoutDischarge;
    assert.deepEqual([record.reason, time(record.lastSeenAt), record.by, time(record.at)], [LWD_REASON, lastSeen.getTime(), { id: NURSE.id, name: NURSE.name }, recorded.getTime()]);
    assert.ok(record.announcedAt, 'discharge.completed went');
    // Bed days stop at the last-seen time; the bed went to cleaning now (R25); the patient's status says what happened.
    const adm = await admissionOf();
    assert.deepEqual([adm.status, time(adm.dischargedAt), adm.dischargedBy], ['discharged', lastSeen.getTime(), NURSE.name]);
    const bed = await bedOf();
    assert.deepEqual([bed.state, bed.admission], ['cleaning', null]);
    assert.ok(Math.abs(bed.stateSince.getTime() - clinicNow().getTime()) < 10_000, `stateSince ${bed.stateSince.toISOString()} is not now`);
    assert.equal((await patientOf()).status, 'Left without discharge');
    assert.equal((await m.TaskAlertItem.findOne({ link: reminder }).lean<any>()).status, 'Completed');

    // A16: an escalation on the default ladder, to the Duty administrator, naming the bed, never the patient.
    const escalations = await m.Escalation.find().lean<any[]>();
    assert.equal(escalations.length, 1);
    const [esc] = escalations;
    assert.deepEqual(
      [esc.ladder, esc.source, esc.reason, String(esc.case), esc.state, esc.step, esc.alertLink, esc.closesOnStop],
      ['default', { kind: 'discharge-left', id: planId }, `Left without discharge — ${BED}`, caseId, 'open', 0, undefined, undefined],
    );
    const alert = await m.TaskAlertItem.findById(esc.alert).lean<any>();
    assert.deepEqual([alert.link, alert.title, alert.priority, alert.status], [
      `escalation:${esc._id}`, `Escalated to Duty administrator: Left without discharge — ${BED}`, 'High', 'Pending',
    ]);
    assert.ok(!alert.link.startsWith('discharge-'), 'the holders acknowledge it in Tasks & Alerts');

    // discharge.completed with no order: orderId '', the completion kind, and the last-seen time.
    const [done] = await w.sent('discharge.completed');
    assert.deepEqual([String(done.case), done.summary], [caseId, `${BED}: Patient left (Left without discharge)`]);
    assert.deepEqual({ ...done.payload, leftAt: time(done.payload.leftAt) }, {
      planId, orderId: '', admissionId, bedLabel: BED, kind: 'left-without-discharge', leftAt: lastSeen.getTime(),
    });
    for (const text of [esc.reason, alert.title, done.summary, JSON.stringify(done.payload)]) assert.ok(!/Ravi|Kumar/.test(text), text);

    // Once is enough.
    await assert.rejects(leaving.leftWithoutDischarge(ADMIN, planId, { reason: 'Absconded', lastSeenAt: lastSeen }), (e: unknown) => {
      assert.ok(e instanceof ConflictException, String(e));
      assert.equal((e as ConflictException).message, 'This discharge is complete.');
      return true;
    });
    assert.equal(await m.Escalation.countDocuments(), 1);
    assert.deepEqual(logged, []);
  });

  test('left without discharge ends an active order: its clocks stop and Pharmacy cancels with its own reason', async () => {
    const o = await orders.order(DOC, planId, homeNone({ takeHome: { lines: [pantoprazole40] } }));
    const id = String(o._id);
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['running', 'running']);
    const lastSeen = at(26, 10, 45);

    await leaving.leftWithoutDischarge(ADMIN, planId, { reason: 'Absconded', lastSeenAt: lastSeen });
    const row = await stored(id);
    assert.deepEqual([row.state, time(row.leftAt), row.leftBy, row.endedAs], ['left', lastSeen.getTime(), { id: ADMIN.id, name: ADMIN.name }, 'left-without-discharge']);
    assert.ok(row.announced.includes('discharge.completed'));
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.completedKind, String(plan.order)], ['completed', 'left-without-discharge', id]);
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['met', 'met']);
    const [done] = await w.sent('discharge.completed');
    assert.deepEqual([done.payload.orderId, done.payload.kind], [id, 'left-without-discharge']);
    // The take-home medicine still waiting is cancelled by Pharmacy, with the reason for this kind.
    const [th] = await m.PharmacyLine.find({ order: row.takeHomeOrder }).lean<any[]>();
    assert.deepEqual([th.status, th.cancelled?.reason], ['cancelled', 'Patient left without discharge']);
    assert.equal((await patientOf()).status, 'Left without discharge');
    // R21: it is never timed as a discharge.
    reg.clock = () => NOW;
    assert.equal((await (reg as any).status()).onTimePct, null);
    // The order is gone; Patient left on it is 409.
    await assert.rejects(leaving.left(NURSE, id), /The patient has already left\./);
  });

  test('an order given while left without discharge is recorded is ended too', async () => {
    const realDischarge = beds.discharge.bind(beds);
    let raced: string | null = null;
    // The doctor orders just as the nurse records it: after the check for an open order, before the plan is complete.
    beds.discharge = async (...args: Parameters<BedsService['discharge']>) => {
      raced = String((await orders.order(DOC, planId, homeNone()))._id);
      return realDischarge(...args);
    };
    await leaving.leftWithoutDischarge(NURSE, planId, { reason: 'Absconded', lastSeenAt: at(26, 10, 30) });
    assert.ok(raced);
    const row = await stored(raced);
    assert.deepEqual([row.state, row.endedAs], ['left', 'left-without-discharge']);
    assert.deepEqual((await clocksOf(raced)).map((c) => c.state), ['met', 'met']);
    assert.equal((await planOf()).state, 'completed');
    assert.deepEqual((await w.sent('discharge.completed')).map((x) => x.payload.orderId), [raced]);
  });

  test('a staff user cannot record left without discharge', async () => {
    for (const who of [DESK, DOC, PHARM, LAB]) {
      await assert.rejects(leaving.leftWithoutDischarge(who, planId, { reason: 'Absconded', lastSeenAt: at(26, 9) }), ForbiddenException, who.name);
    }
    assert.equal((await planOf()).state, 'planned');
    assert.equal((await bedOf()).state, 'occupied');
    assert.equal((await patientOf()).status, 'Today');
    assert.equal(await m.Escalation.countDocuments(), 0);
    assert.equal(sendsOf('discharge.completed').length, 0);
  });
});
