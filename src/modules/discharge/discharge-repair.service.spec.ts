import * as assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { DOC, World, buildWorld, pantoprazole40 } from '../../test/pharmacy-fixtures';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AiService } from '../ai/ai.service';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { BedChange, BedEvents } from '../beds/bed-events';
import { BedsService } from '../beds/beds.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { RulesService } from '../coordinator/rules.service';
import { DocumentsService } from '../documents/documents.service';
import { PatientsService } from '../patients/patients.service';
import { SchedulingFollowupsService } from '../scheduling/scheduling-followups.service';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { DischargeAiService } from './discharge-ai';
import { DischargeRegistration } from './discharge-coordinator.registration';
import { DischargeLeavingService } from './discharge-leaving.service';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeOrdersService, OrderInput } from './discharge-orders.service';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeRepairService } from './discharge-repair.service';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeSummaryService } from './discharge-summary.service';

const NURSE = { id: 'n1', name: 'Nurse Anjali Thomas', role: UserRole.NURSE };
const MIN = 60_000;
const HOUR = 60 * MIN;
const BED = 'GWA-12';
const WARD = 'General ward A (men)';
/** A clinic-clock (local) moment in September 2026. */
const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min, 0, 0);
const NOW = at(26, 11);
const ADMITTED = at(24, 10);
const SIGNED_AT = at(26, 10, 30);
const DIAGNOSIS = 'Community-acquired pneumonia, treated';
const LWD_REASON = 'Not in bed at the round; the family took him home';

describe('DischargeRepairService', () => {
  const m = models();
  let w: World;
  let reg: DischargeRegistration;
  let plans: DischargePlansService;
  let lines: DischargeLinesService;
  let orders: DischargeOrdersService;
  let beds: BedsService;
  let leaving: DischargeLeavingService;
  let summary: DischargeSummaryService;
  let documents: DocumentsService;
  let patientsSvc: PatientsService;
  let repair: DischargeRepairService;
  let caseId: string;
  let planId: string;
  let admissionId: string;
  let bedId: string;
  let wardId: unknown;
  let seq: number;
  let start: Date;
  let savedClinic: string | undefined;
  let logged: string[];
  /** Every send the services asked for, with its key; the Coordinator drops a repeat within a minute, so stored messages can't show one. */
  let sends: { type: string; payload: Record<string, unknown>; key?: string }[];
  /** Message types whose sends fail (send() reports false), as a Coordinator outage would. */
  let failing: Set<string>;
  /** `bed.discharged` as the Bed Agent announced it (the bridge below stores the message, as the real one does). */
  let bedAnnounced: BedChange[];
  let bridged: Promise<unknown>[];

  const sendsOf = (type: string) => sends.filter((s) => s.type === type);
  const stored = (id: unknown) => m.DischargeOrder.findById(id).lean<any>();
  const planOf = (id: unknown = planId) => m.DischargePlan.findById(id).lean<any>();
  const bedOf = (id: unknown = bedId) => m.Bed.findById(id).lean<any>();
  const admissionOf = (id: unknown = admissionId) => m.Admission.findById(id).lean<any>();
  const patientOf = (id: unknown = w.patientId) => m.Patient.findById(id).lean<any>();
  const clocksOf = (orderId: unknown) => m.Clock.find({ ref: String(orderId) }).sort({ def: 1 }).lean<any[]>();
  const time = (d: unknown) => (d ? new Date(d as string).getTime() : d);
  /** A real-time due time computed from the clinic clock: `toRealTime` reads two clocks, so it may land a millisecond early. */
  const near = (d: unknown, expected: number) => assert.ok(Math.abs((time(d) as number) - expected) <= 5, `${new Date(d as string).toISOString()} ≈ ${new Date(expected).toISOString()}`);
  const flush = async () => {
    while (bridged.length) await Promise.all(bridged.splice(0));
  };
  /** The whole one-minute pass's repair steps, as the scheduler runs them. */
  const pass = async (now = NOW) => {
    const n =
      (await repair.resendMissing(start)) +
      (await repair.repairSummaries(start)) +
      (await repair.repairOrdersAndPlans(start)) +
      (await repair.repairEndings(now, start));
    await flush();
    return n;
  };
  /** A second pass finds nothing left: it repairs nothing and sends nothing new. */
  const quietSecondPass = async (now = NOW) => {
    const before = { sends: sends.length, beds: bedAnnounced.length };
    assert.equal(await pass(now), 0, 'the second pass repairs nothing');
    assert.deepEqual({ sends: sends.length, beds: bedAnnounced.length }, before, 'and sends nothing new');
  };
  const totals = (charges: number, payments: number) => ({ charges, discounts: 0, payments, refunds: 0, balance: charges - payments });
  const bill = (extra: Record<string, unknown> = {}) =>
    m.Bill.create({
      number: `BL-${String(++seq).padStart(4, '0')}`, patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar',
      kind: 'admission', state: 'settled', case: caseId, admission: admissionId, openedAt: NOW, totals: totals(4200, 4200), ...extra,
    });
  /** A Signed Documents record, as the summary's signing makes. */
  const signedDocument = async () =>
    String(
      (
        await documents.create({
          uhid: w.patientUhid, title: 'Discharge summary', category: 'Discharge Summary', description: 'Signed text', status: 'Signed',
          signedBy: DOC.name, author: DOC.name, date: '26 Sep 2026', signedOn: '26 Sep 2026, 10:30 AM', department: 'General Medicine',
        } as never)
      )._id,
    );
  /**
   * The order's summary, signed by Dr. Shajin with its Documents record (the summary has its own spec), and its
   * `discharge.summary-signed` recorded as sent unless `announced` is false (a send that failed).
   */
  const sign = async (orderId: unknown, announced = true) => {
    const s = await m.DischargeSummary.create({
      order: orderId, kind: 'home', course: { text: 'Treated with antibiotics.', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: SIGNED_AT,
      documentId: await signedDocument(),
    });
    if (announced) await m.DischargeOrder.updateOne({ _id: orderId }, { $addToSet: { announced: 'discharge.summary-signed' } });
    return s;
  };
  /** Home for now + 1 h (its window opens at once) with nothing to take home and no follow-up. */
  const homeNone = (extra: Partial<OrderInput> = {}): OrderInput => ({
    kind: 'home', plannedLeaveAt: new Date(NOW.getTime() + HOUR), diagnosis: DIAGNOSIS, condition: 'improved', takeHome: 'none', followUp: 'none', ...extra,
  });
  /** A Home order made Ready (summary signed, teaching ticked, the bill settled) with its gate pass printed. Returns its id. */
  const readyWithPass = async (onPlan = planId, onAdmission = admissionId) => {
    const o = await orders.order(DOC, onPlan, homeNone());
    const id = String(o._id);
    await bill({ admission: onAdmission });
    await sign(o._id);
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    assert.equal((await stored(id)).state, 'ready');
    await leaving.gatePass(NURSE, id);
    return id;
  };
  /**
   * The stored state a crash leaves partway through Patient left: the guarded `ready → left` always landed; then
   * nothing more ('before-bed'), the bed freed ('bed-freed'), or the admission discharged too ('admission-ended'), with
   * the patient's status and `bed.discharged` never written. The plan never completed and nothing was announced.
   */
  const crashLeft = async (orderId: string, stage: 'before-bed' | 'bed-freed' | 'admission-ended', stay = { bedId, admissionId }) => {
    await m.DischargeOrder.updateOne({ _id: orderId }, { $set: { state: 'left', leftAt: NOW, leftBy: { id: NURSE.id, name: NURSE.name }, endedAs: 'home' } });
    if (stage === 'before-bed') return;
    await m.Bed.updateOne({ _id: stay.bedId }, { $set: { state: 'cleaning', stateSince: NOW, admission: null } });
    if (stage === 'admission-ended') {
      await m.Admission.updateOne({ _id: stay.admissionId }, { $set: { status: 'discharged', dischargedAt: NOW, dischargedBy: NURSE.name } });
    }
  };
  /** Another patient admitted to a bed of their own, with an open ward case, and a plan unless `withPlan` is false. */
  const anotherStay = async (uhid: string, name: string, number: number, withPlan = true, admittedAt = ADMITTED) => {
    const p = await m.Patient.create({ uhid, name, age: 48, gender: 'Male', phone: '9100000077', status: 'Admitted' });
    const onCase = String((await w.openWard(String(p._id), uhid, name)).case._id);
    const b = await m.Bed.create({ ward: wardId, label: `GWA-${number}`, number, state: 'occupied' });
    const a = await m.Admission.create({
      patient: p._id, patientUhid: uhid, patientName: name, bed: b._id, doctor: 'Dr. Shajin', department: 'General Medicine',
      roomClass: 'general', expectedStayDays: 2, admittedAt, admittedBy: NURSE.name,
    });
    await m.Bed.updateOne({ _id: b._id }, { $set: { admission: a._id } });
    await w.cases.addRefs(onCase, { admissionId: String(a._id) });
    const plan = withPlan
      ? await m.DischargePlan.create({
          admission: a._id, case: onCase, patient: p._id, patientUhid: uhid, patientName: name, bedLabel: `GWA-${number}`, wardName: WARD,
          doctor: 'Dr. Shajin', targetDay: '2026-09-26', targetAt: at(26, 11), state: 'planned', announcedAt: new Date(),
        })
      : null;
    return { patientId: String(p._id), caseId: onCase, planId: plan ? String(plan._id) : '', admissionId: String(a._id), bedId: String(b._id) };
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
    // The Bed Agent's messages, so its bed.discharged can be stored as the bridge stores it.
    w.registry.register({ key: 'bed', messageTypes: BED_MESSAGE_TYPES, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new DischargeSettingsService(settingsService);
    const rules = new RulesService(w.registry, settingsService, new CoordinatorEvents());
    reg = new DischargeRegistration(w.registry, w.messages, w.cases, settings, m.DischargePlan, m.DischargeOrder, m.Admission);
    logged = [];
    const logger = { error: (x: string) => logged.push(x), warn: (x: string) => logged.push(x), log: () => undefined };
    (reg as any).logger = logger;
    reg.onModuleInit();
    sends = [];
    failing = new Set();
    const send = reg.send.bind(reg);
    reg.send = async (type, onCase, payload, text, opts) => {
      if (failing.has(type)) return false;
      sends.push({ type, payload, key: opts?.dedupeKey });
      return send(type, onCase, payload, text, opts);
    };
    plans = new DischargePlansService(reg, w.messages, rules, settings, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Case, m.TaskAlertItem, m.Patient);
    (plans as any).logger = logger;
    plans.clock = () => NOW;
    patientsSvc = new PatientsService(m.Patient);
    const bedEvents = new BedEvents();
    bedAnnounced = [];
    bridged = [];
    bedEvents.bedChanges$.subscribe((c) => {
      if (c.kind !== 'discharged') return;
      bedAnnounced.push(c);
      bridged.push(
        w.messages.send({
          case: null, from: 'bed', to: ['coordinator'], type: 'bed.discharged', priority: 'low', summary: `${c.patientUhid ?? 'A patient'} left ${c.bedLabel}`,
          payload: { bedId: c.bedId, bedLabel: c.bedLabel, ...(c.admissionId ? { admissionId: c.admissionId } : {}) }, dedupeKey: `bed.discharged:${new Types.ObjectId()}`,
        }),
      );
    });
    beds = new BedsService(m.Ward, m.Bed, m.Admission, patientsSvc, bedEvents, m.DischargeOrder);
    lines = new DischargeLinesService(
      reg, w.messages, w.cases, m.DischargeOrder, m.DischargePlan, m.DischargeSummary, m.LabRequest, m.LabLine, m.PharmacyLine, m.FollowUpItem, m.Bill, m.ChargeLine,
    );
    (lines as any).logger = logger;
    lines.clock = () => NOW;
    documents = new DocumentsService(m.ClinicalDocument);
    const ai = new DischargeAiService(
      new AiService({ name: 'none', model: 'm', complete: async () => ({}), check: async () => ({ ok: true, detail: '' }) }, { getSettings: async () => ({ ai: {} }) } as any, { get: () => 50 } as any),
    );
    summary = new DischargeSummaryService(
      reg, lines, settings, w.cases, ai, documents, new TimelineService(m.TimelineEvent),
      m.DischargeSummary, m.DischargeOrder, m.DischargePlan, m.Admission, m.Bed, m.Ward, m.Patient, m.LabRequest, m.LabLine, m.PharmacyOrder, m.PharmacyLine,
      m.FollowUpItem, m.ProcedureBooking,
    );
    (summary as any).logger = logger;
    summary.clock = () => NOW;
    // The orders here neither draft nor archive a summary themselves: these specs write summaries, and a lost draft or a
    // failed archive is exactly what the pass repairs.
    const noSummary = { draft: async () => null, archiveForCancel: async () => false } as unknown as DischargeSummaryService;
    orders = new DischargeOrdersService(
      reg, plans, settings, w.cases, beds, w.takeHome, {} as SchedulingFollowupsService, lines, noSummary, m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.PharmacyLine,
    );
    (orders as any).logger = logger;
    orders.clock = () => NOW;
    leaving = new DischargeLeavingService(
      reg, plans, orders, lines, settings, beds, w.escalations, m.DischargePlan, m.DischargeOrder, m.Admission, m.Bed, m.Bill, m.CoordinatorCounter, w.messages,
    );
    (leaving as any).logger = logger;
    leaving.clock = () => NOW;
    repair = new DischargeRepairService(plans, orders, lines, summary, leaving, w.takeHome, m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.PharmacyOrder, m.PharmacyLine);
    (repair as any).logger = logger;
    // Every record a test writes is past every grace, and after the agent's start.
    start = new Date(Date.now() - HOUR);
    repair.realNow = () => Date.now() + HOUR;

    caseId = String((await w.openWard()).case._id);
    await m.Patient.updateOne({ _id: w.patientId }, { $set: { status: 'Admitted' } });
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
      doctor: 'Dr. Shajin', targetDay: '2026-09-26', targetAt: at(26, 11), state: 'planned', announcedAt: new Date(),
    });
    planId = String(plan._id);
  });
  afterEach(async () => {
    await flush();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  });

  // ---------- steps 1 and 4: orphan plans and open lines ----------

  test('Task 4 R1-B2: a planned plan whose admission no longer exists is dropped once 10 minutes old; one with an admission, or an order, stays', async () => {
    const backdate = (id: unknown, ms: number) => m.DischargePlan.collection.updateOne({ _id: new Types.ObjectId(String(id)) }, { $set: { createdAt: new Date(Date.now() - ms) } });
    // The twin-room gap: the plan was opened, then the Bed Agent lost the bed and deleted the admission.
    const gone = await anotherStay('MHK202600925', 'Mary Jeni', 15);
    await m.Admission.deleteOne({ _id: gone.admissionId });
    await m.TaskAlertItem.create({
      link: `discharge-plan:${gone.planId}:reminder`, title: 'Discharge due today, no order yet: GWA-15', subtitle: 'x', patientName: 'Mary Jeni',
      uhid: 'MHK202600925', type: 'System', category: 'Follow-up', priority: 'Medium', status: 'Pending',
    });
    // The same, but an order points at the plan: never dropped.
    const ordered = await anotherStay('MHK202600926', 'John Peter', 16);
    await m.Admission.deleteOne({ _id: ordered.admissionId });
    await m.DischargePlan.updateOne({ _id: ordered.planId }, { $set: { order: new Types.ObjectId() } });
    for (const p of [planId, gone.planId, ordered.planId]) await backdate(p, 5 * MIN);

    assert.equal(await plans.dropOrphans(), 0, 'under 10 minutes old: the stay may still be being placed');
    for (const p of [planId, gone.planId, ordered.planId]) await backdate(p, 11 * MIN);
    assert.equal(await plans.dropOrphans(), 1);
    assert.equal(await m.DischargePlan.countDocuments({ _id: gone.planId }), 0);
    assert.equal((await m.TaskAlertItem.findOne({ link: `discharge-plan:${gone.planId}:reminder` }).lean<any>()).status, 'Completed');
    assert.equal(await m.DischargePlan.countDocuments({ _id: { $in: [planId, ordered.planId] } }), 2);
    assert.equal(await plans.dropOrphans(), 0);
  });

  test("refreshOpen reads every open order's lines again, and only open orders", async () => {
    const id = String((await orders.order(DOC, planId, homeNone()))._id);
    const other = await anotherStay('MHK202600927', 'Mary Jeni', 15);
    const closed = String((await orders.order(DOC, other.planId, homeNone()))._id);
    await orders.cancel(DOC, closed, 'Not today');
    // The teaching line ticked by a person, and a bill settled since the last read, which no message announced.
    await lines.tick(NURSE, id, 'teaching', { state: 'done' });
    await sign(id);
    await bill();
    await m.DischargeOrder.updateOne({ _id: closed }, { $set: { 'lines.$[l].state': 'done' } }, { arrayFilters: [{ 'l.key': 'bill' }] });
    assert.equal((await stored(id)).lines.find((l: any) => l.key === 'bill').state, 'needs-person');

    assert.equal(await lines.refreshOpen(), 1);
    const row = await stored(id);
    assert.deepEqual([row.lines.find((l: any) => l.key === 'bill').state, row.state], ['done', 'ready']);
    assert.equal((await stored(closed)).lines.find((l: any) => l.key === 'bill').state, 'done', 'a cancelled order is left as it is');
  });

  // ---------- step 5: re-sends ----------

  test('discharge.planned goes again for a plan never announced, under its own key for the day; a second pass sends nothing', async () => {
    await m.DischargePlan.updateOne({ _id: planId }, { $unset: { announcedAt: 1 } });
    // A moved target says so.
    const other = await anotherStay('MHK202600911', 'Mary Jeni', 15);
    await m.DischargePlan.updateOne(
      { _id: other.planId },
      { $push: { targetLog: { from: '2026-09-26', to: '2026-09-28', by: { id: DOC.id, name: DOC.name }, at: NOW } }, $set: { targetDay: '2026-09-28' }, $unset: { announcedAt: 1 } },
    );
    // A completed plan is never planned again.
    const done = await anotherStay('MHK202600912', 'John Peter', 16);
    await m.DischargePlan.updateOne({ _id: done.planId }, { $set: { state: 'completed' }, $unset: { announcedAt: 1 } });

    assert.equal(await repair.resendMissing(start), 2);
    const planned = sendsOf('discharge.planned');
    assert.deepEqual(planned.map((s) => [s.payload.planId, s.payload.targetDay, s.key]).sort(), [
      [planId, '2026-09-26', `discharge.planned:${planId}:2026-09-26:resend`],
      [other.planId, '2026-09-28', `discharge.planned:${other.planId}:2026-09-28:resend`],
    ].sort());
    const msgs = await w.sent('discharge.planned');
    assert.deepEqual(msgs.map((x) => x.summary).sort(), ['GWA-12: Discharge planned for 26 Sep 2026', 'GWA-15: Discharge target moved to 28 Sep 2026']);
    assert.ok((await planOf()).announcedAt, 'stamped once it went');
    await quietSecondPass();
  });

  test('discharge.ordered goes again for an order in progress whose send failed', async () => {
    failing.add('discharge.ordered');
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    assert.ok(!(await stored(id)).announced.includes('discharge.ordered'));
    failing.clear();

    assert.ok((await pass()) >= 1);
    const [msg] = await w.sent('discharge.ordered');
    assert.deepEqual([msg.dedupeKey, msg.payload.orderId, msg.payload.planId, msg.payload.bedLabel, msg.payload.kind, time(msg.payload.plannedLeaveAt)], [
      `discharge.ordered:${id}:resend`, id, planId, BED, 'home', NOW.getTime() + HOUR,
    ]);
    assert.equal(msg.summary, 'GWA-12: Discharge ordered (Home)');
    assert.ok((await stored(id)).announced.includes('discharge.ordered'));
    await quietSecondPass();
  });

  test('discharge.window-opened goes again for a window claimed but never announced, with the same due times; never for an order no longer in progress', async () => {
    // Leaving in 5 hours: the window opens at 14:00, so the order is saved with it closed.
    const o = await orders.order(DOC, planId, homeNone({ plannedLeaveAt: new Date(NOW.getTime() + 5 * HOUR) }));
    const id = String(o._id);
    assert.equal((await clocksOf(id)).length, 0);
    // A crash between the claim and the send (Start now at 11:00).
    await m.DischargeOrder.updateOne({ _id: id }, { $set: { windowAt: NOW, windowOpenedAt: new Date() } });
    // Another order, cancelled with its window claimed but not announced: its window must never open now.
    const other = await anotherStay('MHK202600913', 'Mary Jeni', 15);
    const o2 = await orders.order(DOC, other.planId, homeNone({ plannedLeaveAt: new Date(NOW.getTime() + 5 * HOUR) }));
    await orders.cancel(DOC, String(o2._id), 'Fever again');
    await m.DischargeOrder.updateOne({ _id: o2._id }, { $set: { windowAt: NOW, windowOpenedAt: new Date() } });

    await pass();
    const opened = await w.sent('discharge.window-opened');
    assert.equal(opened.length, 1);
    assert.deepEqual([opened[0].dedupeKey, opened[0].payload.orderId, opened[0].payload.summarySigned], [`discharge.window-opened:${id}:resend`, id, false]);
    near(opened[0].payload.leaveDueAt, NOW.getTime() + 120 * MIN);
    near(opened[0].payload.summaryDueAt, NOW.getTime() + 60 * MIN);
    const clocks = await clocksOf(id);
    assert.deepEqual(clocks.map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'running']]);
    near(clocks[0].dueAt, NOW.getTime() + 120 * MIN);
    near(clocks[1].dueAt, NOW.getTime() + 60 * MIN);
    assert.equal((await clocksOf(o2._id)).length, 0);
    await quietSecondPass();
  });

  test('discharge.ready goes again under discharge.ready:<orderId>:<readyCount>', async () => {
    failing.add('discharge.ready');
    const id = await readyWithPass();
    const row = await stored(id);
    assert.deepEqual([row.state, row.readyCount, row.announced.includes('discharge.ready')], ['ready', 1, false]);
    failing.clear();

    await repair.resendMissing(start);
    assert.deepEqual(sendsOf('discharge.ready').map((s) => s.key), [`discharge.ready:${id}:1`]);
    const [msg] = await w.sent('discharge.ready');
    assert.deepEqual([msg.dedupeKey, msg.payload, msg.summary], [`discharge.ready:${id}:1`, { orderId: id, bedLabel: BED, kind: 'home' }, 'GWA-12: Ready to leave (Home)']);
    assert.ok((await stored(id)).announced.includes('discharge.ready'));
    await quietSecondPass();
  });

  test('discharge.summary-signed goes again for a signed summary never announced, and stops the summary clock', async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const id = String(o._id);
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['running', 'running']);
    // Signed, but the message never went (a failed send).
    const s = await sign(o._id, false);

    await repair.resendMissing(start);
    const [msg] = await w.sent('discharge.summary-signed');
    assert.deepEqual([msg.dedupeKey, msg.payload], [`discharge.summary-signed:${id}:1:resend`, { orderId: id, summaryId: String(s._id), bedLabel: BED, kind: 'home' }]);
    assert.deepEqual((await clocksOf(id)).map((c) => [c.def, c.state]), [['discharge-leave', 'running'], ['discharge-summary', 'met']]);
    // A summary archived after a cancel is no longer current, so it is never announced.
    const other = await anotherStay('MHK202600914', 'Mary Jeni', 15);
    const o2 = await orders.order(DOC, other.planId, homeNone());
    await m.DischargeSummary.create({ order: o2._id, kind: 'home', course: { text: 'x', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: SIGNED_AT, archivedAt: NOW });
    await quietSecondPass();
  });

  test('discharge.cancelled goes again and stops the clocks, but never while a newer live order is on the plan', async () => {
    failing.add('discharge.cancelled');
    const first = String((await orders.order(DOC, planId, homeNone()))._id);
    await orders.cancel(DOC, first, 'Spiked a fever again');
    failing.clear();
    assert.deepEqual((await clocksOf(first)).map((c) => c.state), ['running', 'running'], 'nothing stopped them');
    // The doctor re-orders at once: Pharmacy cancels every waiting take-home line of the case on discharge.cancelled,
    // so the old stop must not go while this one lives.
    const second = String((await orders.order(DOC, planId, homeNone({ takeHome: { lines: [pantoprazole40] } })))._id);

    assert.equal(await repair.resendMissing(start), 0);
    assert.equal((await w.sent('discharge.cancelled')).length, 0);
    const [th] = await m.PharmacyLine.find({ order: (await stored(second)).takeHomeOrder }).lean<any[]>();
    assert.equal(th.status, 'to-check', "the newer order's medicine still waits");

    // Once no live order is left, the old stop goes, under its own key.
    await orders.cancel(DOC, second, 'Not today');
    sends = [];
    assert.equal(await repair.resendMissing(start), 1);
    assert.deepEqual(sendsOf('discharge.cancelled').map((s) => [s.payload.orderId, s.key]), [[first, `discharge.cancelled:${first}:resend`]]);
    assert.deepEqual((await clocksOf(first)).map((c) => c.state), ['met', 'met']);
    assert.ok((await stored(first)).announced.includes('discharge.cancelled'));
    await quietSecondPass();
  });

  test('I1 (review): a newer order that leaves releases the old stop', async () => {
    failing.add('discharge.cancelled');
    const first = String((await orders.order(DOC, planId, homeNone()))._id);
    await orders.cancel(DOC, first, 'Spiked a fever again');
    failing.clear();
    // The doctor re-orders, and that patient leaves: Pharmacy's discharge.completed already cancelled its waiting lines.
    const second = await readyWithPass();
    await leaving.left(NURSE, second);
    await flush();
    assert.deepEqual((await clocksOf(first)).map((c) => c.state), ['running', 'running']);
    sends = [];

    assert.equal(await repair.resendMissing(start), 1);
    assert.deepEqual(sendsOf('discharge.cancelled').map((s) => [s.payload.orderId, s.key]), [[first, `discharge.cancelled:${first}:resend`]]);
    assert.deepEqual((await clocksOf(first)).map((c) => c.state), ['met', 'met'], 'its clocks stop instead of escalating for ever');
    assert.equal(await repair.resendMissing(start), 0);
  });

  test("I1 (review): a previous stay's left order on the same case doesn't block the stop", async () => {
    // An earlier stay of the patient, on the same open case, ended long ago.
    const oldBed = await m.Bed.create({ ward: wardId, label: 'GWA-30', number: 30, state: 'free' });
    const oldStay = await m.Admission.create({
      patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar', bed: oldBed._id, doctor: 'Dr. Shajin', department: 'General Medicine',
      roomClass: 'general', expectedStayDays: 2, admittedAt: at(10, 10), admittedBy: NURSE.name, status: 'discharged', dischargedAt: at(12, 11),
    });
    const oldPlan = await m.DischargePlan.create({
      admission: oldStay._id, case: caseId, patient: w.patientId, patientUhid: w.patientUhid, patientName: 'Ravi Kumar', bedLabel: 'GWA-30', wardName: WARD,
      doctor: 'Dr. Shajin', targetDay: '2026-09-12', targetAt: at(12, 11), state: 'completed', completedKind: 'home', completedAt: at(12, 11), announcedAt: new Date(),
    });
    await m.DischargeOrder.create({
      plan: oldPlan._id, admission: oldStay._id, case: caseId, patient: w.patientId, kind: 'home', state: 'left', plannedLeaveAt: at(12, 11), windowAt: at(12, 9),
      diagnosis: DIAGNOSIS, orderedBy: { id: DOC.id, name: DOC.name }, orderedAt: at(12, 9), leftAt: at(12, 11), endedAs: 'home',
      announced: ['discharge.ordered', 'discharge.window-opened', 'discharge.ready', 'discharge.summary-signed', 'discharge.completed'],
    });
    failing.add('discharge.cancelled');
    const id = String((await orders.order(DOC, planId, homeNone()))._id);
    await orders.cancel(DOC, id, 'Spiked a fever again');
    failing.clear();

    assert.equal(await repair.resendMissing(start), 1);
    assert.deepEqual(sendsOf('discharge.cancelled').map((s) => s.payload.orderId), [id]);
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['met', 'met']);
  });

  test('discharge.completed goes again from the order, or from the Left-without-discharge record with no order; never for a plan that never completed', async () => {
    const id = await readyWithPass();
    failing.add('discharge.completed');
    await leaving.left(NURSE, id);
    // Left without discharge on another stay, with no order.
    const other = await anotherStay('MHK202600915', 'Mary Jeni', 15);
    await leaving.leftWithoutDischarge(NURSE, other.planId, { reason: LWD_REASON, lastSeenAt: at(26, 10) });
    // A third stay cut short by a crash right after its order left: a half-ended stay, not a missing message.
    const third = await anotherStay('MHK202600916', 'John Peter', 16);
    const id3 = await readyWithPass(third.planId, third.admissionId);
    await crashLeft(id3, 'before-bed', third);
    failing.clear();
    await flush();
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['running', 'running']);

    assert.equal(await repair.resendMissing(start), 2);
    const done = await w.sent('discharge.completed');
    assert.deepEqual(done.map((x) => [x.dedupeKey, x.payload.planId, x.payload.orderId, x.payload.kind, x.summary]).sort(), [
      [`discharge.completed:${id}:resend`, planId, id, 'home', 'GWA-12: Patient left (Home)'],
      [`discharge.completed:plan:${other.planId}:resend`, other.planId, '', 'left-without-discharge', 'GWA-15: Patient left (Left without discharge)'],
    ].sort());
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['met', 'met']);
    assert.ok((await stored(id)).announced.includes('discharge.completed'));
    assert.ok((await planOf(other.planId)).leftWithoutDischarge.announcedAt);
    assert.ok(!(await stored(id3)).announced.includes('discharge.completed'));
    assert.equal(await repair.resendMissing(start), 0);
  });

  test('R17: the catch-up plans an admission from before the start stamp, but re-sends and back-fills never look before it', async () => {
    // The agent first ran just now; this stay was admitted a month before.
    start = new Date(Date.now() + MIN);
    const old = await anotherStay('MHK202600917', 'Mary Jeni', 15, false, at(1, 9));
    assert.equal(await plans.catchUp(), 1);
    const plan = await m.DischargePlan.findOne({ admission: old.admissionId }).lean<any>();
    assert.ok(plan?.announcedAt, 'planned, and announced by its first send');

    // Records written before the stamp: a plan never announced, an order in progress with no summary, a half-ended stay.
    await m.DischargePlan.updateOne({ _id: planId }, { $unset: { announcedAt: 1 } });
    failing.add('discharge.ordered');
    const id = String((await orders.order(DOC, String(plan._id), homeNone()))._id);
    failing.clear();
    const third = await anotherStay('MHK202600918', 'John Peter', 16);
    const id3 = await readyWithPass(third.planId, third.admissionId);
    await crashLeft(id3, 'bed-freed', third);
    sends = [];
    assert.equal(await pass(), 0);
    assert.deepEqual(sends, []);
    assert.equal(await m.DischargeSummary.countDocuments({ order: id }), 0);
    assert.equal((await admissionOf(third.admissionId)).status, 'active');

    // With the stamp before them, the same records are repaired.
    start = new Date(Date.now() - HOUR);
    assert.ok((await pass()) >= 4);
    assert.deepEqual(sendsOf('discharge.planned').map((s) => s.payload.planId), [planId]);
    assert.deepEqual(sendsOf('discharge.ordered').map((s) => s.payload.orderId), [id]);
    assert.equal(await m.DischargeSummary.countDocuments({ order: id }), 1);
    assert.equal((await admissionOf(third.admissionId)).status, 'discharged');
  });

  test('records younger than the grace are left alone: the request that wrote them may still be sending', async () => {
    failing.add('discharge.ordered');
    const id = String((await orders.order(DOC, planId, homeNone()))._id);
    failing.clear();
    repair.realNow = () => Date.now();
    assert.equal(await repair.resendMissing(start), 0);
    repair.realNow = () => Date.now() + HOUR;
    assert.equal(await repair.resendMissing(start), 1);
    assert.deepEqual(sendsOf('discharge.ordered').map((s) => s.payload.orderId), [id]);
  });

  // ---------- step 6: summaries ----------

  test("R35: a cancelled order's signed summary whose archive failed is archived, document and all", async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const s = await sign(o._id);
    await orders.cancel(DOC, String(o._id), 'Spiked a fever again');
    assert.equal((await m.ClinicalDocument.findById(s.documentId).lean<any>()).status, 'Signed');

    assert.equal(await repair.repairSummaries(start), 1);
    assert.equal((await m.ClinicalDocument.findById(s.documentId).lean<any>()).status, 'Archived');
    assert.equal(time((await m.DischargeSummary.findById(s._id).lean<any>()).archivedAt), NOW.getTime());
    assert.equal(await repair.repairSummaries(start), 0);
  });

  test("Task 10 M6: a kept version's document still Signed is archived", async () => {
    const o = await orders.order(DOC, planId, homeNone());
    const kept = await signedDocument();
    const archived = await signedDocument();
    await documents.archive(archived);
    await m.DischargeSummary.create({
      order: o._id, kind: 'home', course: { text: 'x', source: 'staff' },
      versions: [
        { sections: {}, course: { text: 'x', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: SIGNED_AT, documentId: kept },
        { sections: {}, course: { text: 'y', source: 'staff' }, signedBy: { id: DOC.id, name: DOC.name }, signedAt: SIGNED_AT, documentId: archived },
      ],
    });
    assert.equal(await repair.repairSummaries(start), 1);
    assert.deepEqual((await m.ClinicalDocument.find({ _id: { $in: [kept, archived] } }).lean<any[]>()).map((d) => d.status), ['Archived', 'Archived']);
    assert.equal(await repair.repairSummaries(start), 0);
  });

  test('Task 10 M8: an order in progress with no summary (its draft was lost) gets one drafted', async () => {
    const id = String((await orders.order(DOC, planId, homeNone()))._id);
    assert.equal(await m.DischargeSummary.countDocuments({ order: id }), 0);
    assert.equal(await repair.repairSummaries(start), 1);
    const s = await m.DischargeSummary.findOne({ order: id }).lean<any>();
    assert.deepEqual([s.kind, s.course.source, s.sections.diagnosis], ['home', 'rules', DIAGNOSIS]);
    assert.equal(await repair.repairSummaries(start), 0);
  });

  // ---------- step 7: orders and plans ----------

  test('Task 8 M2: an order in progress whose plan is still planned: the plan follows the order and the reminder closes', async () => {
    const id = String((await orders.order(DOC, planId, homeNone()))._id);
    // The plan step after the order failed, and the morning reminder was raised meanwhile.
    await m.DischargePlan.updateOne({ _id: planId }, { $set: { state: 'planned' }, $unset: { order: 1 } });
    await m.TaskAlertItem.create({
      link: `discharge-plan:${planId}:reminder`, title: 'Discharge due today, no order yet: GWA-12', subtitle: 'For Dr. Shajin', patientName: 'Ravi Kumar',
      uhid: w.patientUhid, type: 'System', category: 'Follow-up', priority: 'Medium', status: 'Pending',
    });

    assert.equal(await repair.repairOrdersAndPlans(start), 1);
    const plan = await planOf();
    assert.deepEqual([plan.state, String(plan.order)], ['ordered', id]);
    assert.equal((await m.TaskAlertItem.findOne({ link: `discharge-plan:${planId}:reminder` }).lean<any>()).status, 'Completed');
    assert.equal(await repair.repairOrdersAndPlans(start), 0);
  });

  test('M4 (review): a cancel that lands while the plan is put right never leaves the plan pointing at the cancelled order', async () => {
    const id = String((await orders.order(DOC, planId, homeNone()))._id);
    await m.DischargePlan.updateOne({ _id: planId }, { $set: { state: 'planned' }, $unset: { order: 1 } });
    // The doctor cancels between the pass's read of the order and its plan write.
    const plansModel = m.DischargePlan as any;
    const real = plansModel.updateOne;
    plansModel.updateOne = function (...args: unknown[]) {
      delete plansModel.updateOne;
      const write = real.apply(plansModel, args);
      return { exec: async () => (await orders.cancel(DOC, id, 'Changed my mind'), write.exec()) };
    };
    try {
      assert.equal(await repair.repairOrdersAndPlans(start), 0);
    } finally {
      delete plansModel.updateOne;
    }
    assert.equal((await stored(id)).state, 'cancelled');
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.order], ['planned', undefined]);
    assert.equal(await repair.repairOrdersAndPlans(start), 0);
  });

  test('Task 8 M2: an orphan take-home order is cancelled ("Discharge order not saved"); one an order owns, or under 10 minutes old, is not', async () => {
    // A crash between placing the take-home order and saving the discharge order.
    const orphan = await w.takeHome.place(DOC, { patientId: w.patientId, caseId, plannedLeaveAt: new Date(NOW.getTime() + HOUR), lines: [pantoprazole40] });
    // A real order's take-home order, on another stay.
    const other = await anotherStay('MHK202600919', 'Mary Jeni', 15);
    const owned = await orders.order(DOC, other.planId, homeNone({ takeHome: { lines: [pantoprazole40] } }));
    const linesOf = async (orderId: unknown) => m.PharmacyLine.find({ order: orderId }).lean<any[]>();

    repair.realNow = () => Date.now() + 5 * MIN;
    assert.equal(await repair.repairOrdersAndPlans(start), 0, 'under 10 minutes old: still being saved, perhaps');
    repair.realNow = () => Date.now() + HOUR;
    assert.equal(await repair.repairOrdersAndPlans(start), 1);
    assert.deepEqual((await linesOf(orphan.id)).map((l) => [l.status, l.cancelled?.reason]), [['cancelled', 'Discharge order not saved']]);
    assert.deepEqual((await linesOf((await stored(owned._id)).takeHomeOrder)).map((l) => l.status), ['to-check']);
    assert.equal(await repair.repairOrdersAndPlans(start), 0);
  });

  // ---------- step 8: half-ended stays ----------

  test('half-ended, the bed freed but the admission still active: the admission ends at the leaving time, the status is set, bed.discharged and discharge.completed go', async () => {
    const id = await readyWithPass();
    await crashLeft(id, 'bed-freed');
    await flush();
    bedAnnounced = [];
    sends = [];

    assert.equal(await repair.repairEndings(NOW, start), 1);
    await flush();
    const admission = await admissionOf();
    assert.deepEqual([admission.status, time(admission.dischargedAt), admission.dischargedBy], ['discharged', NOW.getTime(), NURSE.name]);
    assert.equal((await patientOf()).status, 'Discharged');
    assert.deepEqual(bedAnnounced.map((c) => [c.bedLabel, c.admissionId]), [[BED, admissionId]]);
    assert.ok(await w.messages.findOne('bed.discharged', { admissionId }));
    const plan = await planOf();
    assert.deepEqual([plan.state, plan.completedKind, time(plan.completedAt), !!plan.endingCheckedAt], ['completed', 'home', NOW.getTime(), true]);
    assert.deepEqual(sendsOf('discharge.completed').map((s) => [s.payload.orderId, s.key]), [[id, `discharge.completed:${id}:resend`]]);
    assert.deepEqual((await clocksOf(id)).map((c) => c.state), ['met', 'met']);
    assert.equal((await bedOf()).state, 'cleaning');
    await quietSecondPass();
  });

  test('half-ended, the admission ended but its status and bed.discharged never followed: both are set; a whole ending is only marked checked', async () => {
    // A crash after the admission was discharged (the plan never completed).
    const id = await readyWithPass();
    await crashLeft(id, 'admission-ended');
    // A Bed Agent failure after its admission write: the leaving stood, the plan completed and discharge.completed went.
    const other = await anotherStay('MHK202600920', 'Mary Jeni', 15);
    const id2 = await readyWithPass(other.planId, other.admissionId);
    const real = beds.discharge.bind(beds);
    beds.discharge = async (bed: string) => {
      await m.Bed.updateOne({ _id: bed }, { $set: { state: 'cleaning', admission: null } });
      await m.Admission.updateOne({ _id: other.admissionId }, { $set: { status: 'discharged', dischargedAt: NOW, dischargedBy: NURSE.name } });
      throw new Error('the patient service timed out');
    };
    await leaving.left(NURSE, id2);
    beds.discharge = real;
    assert.equal((await planOf(other.planId)).state, 'completed');
    // A third stay ended whole, as it should.
    const third = await anotherStay('MHK202600921', 'John Peter', 16);
    const id3 = await readyWithPass(third.planId, third.admissionId);
    await leaving.left(NURSE, id3);
    await flush();
    assert.equal((await patientOf(third.patientId)).status, 'Discharged');
    bedAnnounced = [];
    sends = [];

    assert.equal(await repair.repairEndings(NOW, start), 2);
    await flush();
    for (const [patient, admission] of [[w.patientId, admissionId], [other.patientId, other.admissionId]]) {
      assert.equal((await patientOf(patient)).status, 'Discharged', patient);
      assert.ok(await w.messages.findOne('bed.discharged', { admissionId: admission }), admission);
    }
    assert.deepEqual(bedAnnounced.map((c) => c.admissionId).sort(), [admissionId, other.admissionId].sort(), 'the whole ending announced nothing again');
    // Only the crashed stay was missing its discharge.completed.
    assert.deepEqual(sendsOf('discharge.completed').map((s) => s.payload.orderId), [id]);
    assert.equal((await planOf()).state, 'completed');
    for (const p of [planId, other.planId, third.planId]) assert.ok((await planOf(p)).endingCheckedAt, p);
    await quietSecondPass();
  });

  test('left with the bed still occupied: put back to Ready when nothing was announced; finished through the Bed Agent once the plan completed', async () => {
    // A crash between the guarded ready → left and the bed call.
    const id = await readyWithPass();
    await crashLeft(id, 'before-bed');
    // The same, but the plan completed and discharge.completed went (a transfer moved the stay as its bed was freed).
    const other = await anotherStay('MHK202600922', 'Mary Jeni', 15);
    const id2 = await readyWithPass(other.planId, other.admissionId);
    await crashLeft(id2, 'before-bed', other);
    await m.DischargePlan.updateOne({ _id: other.planId }, { $set: { state: 'completed', completedKind: 'home', completedAt: NOW } });
    await m.DischargeOrder.updateOne({ _id: id2 }, { $addToSet: { announced: 'discharge.completed' } });
    // And again, but only the plan step failed: discharge.completed went, so the stay can't be put back either.
    const third = await anotherStay('MHK202600924', 'John Peter', 16);
    const id3 = await readyWithPass(third.planId, third.admissionId);
    await crashLeft(id3, 'before-bed', third);
    await m.DischargeOrder.updateOne({ _id: id3 }, { $addToSet: { announced: 'discharge.completed' } });
    await flush();
    bedAnnounced = [];
    sends = [];

    assert.equal(await repair.repairEndings(NOW, start), 3);
    await flush();
    // Untouched and never announced: back to Ready, the gate pass kept, for the nurse to press Patient left again.
    const row = await stored(id);
    assert.deepEqual([row.state, row.leftAt, row.endedAs, row.gatePass.number], ['ready', undefined, undefined, 'GP-0001']);
    assert.equal((await planOf()).state, 'ready');
    assert.deepEqual([(await admissionOf()).status, (await bedOf()).state], ['active', 'occupied']);
    assert.equal(sendsOf('discharge.completed').filter((s) => s.payload.orderId === id).length, 0);
    // Completed and announced: the stay ends through the Bed Agent's own discharge, at the leaving time.
    const admission = await admissionOf(other.admissionId);
    assert.deepEqual([admission.status, time(admission.dischargedAt)], ['discharged', NOW.getTime()]);
    assert.deepEqual([(await bedOf(other.bedId)).state, (await patientOf(other.patientId)).status], ['cleaning', 'Discharged']);
    assert.deepEqual(bedAnnounced.map((c) => c.admissionId).sort(), [other.admissionId, third.admissionId].sort());
    const ended = await stored(id3);
    assert.deepEqual([ended.state, (await planOf(third.planId)).state, (await admissionOf(third.admissionId)).status], ['left', 'completed', 'discharged']);
    assert.equal(sendsOf('discharge.completed').length, 0, 'it had gone already');
    await quietSecondPass();
    // And the nurse can end the first stay now.
    await leaving.left(NURSE, id);
    assert.equal((await stored(id)).state, 'left');
  });

  test('M2 (review): a failed patient read or write leaves the stay unchecked, and the next pass finishes it', async () => {
    const id = await readyWithPass();
    await crashLeft(id, 'admission-ended');
    await flush();
    // The patient record can't be read or written for a moment.
    const blip = async () => {
      throw new Error('database blip');
    };
    Object.assign(patientsSvc as any, { findOne: blip, setStatusIf: blip });
    try {
      await repair.repairEndings(NOW, start);
    } finally {
      delete (patientsSvc as any).findOne;
      delete (patientsSvc as any).setStatusIf;
    }
    assert.equal((await patientOf()).status, 'Admitted');
    assert.equal((await planOf()).endingCheckedAt, undefined, 'not marked checked, so it is tried again');
    assert.ok(logged.some((l) => /database blip/.test(l)), logged.join(' | '));

    assert.equal(await repair.repairEndings(NOW, start), 1);
    await flush();
    assert.equal((await patientOf()).status, 'Discharged');
    const plan = await planOf();
    assert.deepEqual([plan.state, !!plan.endingCheckedAt], ['completed', true]);
    await quietSecondPass();
  });

  test("M5 (review): the stay's end is announced only once its plan is really completed", async () => {
    const id = await readyWithPass();
    await crashLeft(id, 'bed-freed');
    await flush();
    sends = [];
    // The plan's completion fails once (the leaving service logs it and carries on).
    const plansModel = m.DischargePlan as any;
    const real = plansModel.updateOne;
    plansModel.updateOne = function (filter: unknown, update: { $set?: { state?: string } }, ...rest: unknown[]) {
      if (update?.$set?.state !== 'completed') return real.call(plansModel, filter, update, ...rest);
      delete plansModel.updateOne;
      return { exec: async () => Promise.reject(new Error('write conflict')) };
    };
    try {
      await repair.repairEndings(NOW, start);
    } finally {
      delete plansModel.updateOne;
    }
    await flush();
    assert.equal((await planOf()).state, 'ready');
    assert.deepEqual(sendsOf('discharge.completed'), [], 'never for a plan that did not complete');
    assert.equal((await admissionOf()).status, 'discharged', 'the stay itself was finished');

    assert.equal(await repair.repairEndings(NOW, start), 1);
    assert.equal((await planOf()).state, 'completed');
    assert.deepEqual(sendsOf('discharge.completed').map((s) => s.payload.orderId), [id]);
    await quietSecondPass();
  });

  test('a stale Left-without-discharge claim: left alone for 10 minutes, then undone while the stay is untouched, or finished when it already ended', async () => {
    // A crash after the claim and the order's end, before the bed: the stay is untouched. (Its summary is drafted, so the
    // only repairs left are the claims'.)
    const id = String((await orders.order(DOC, planId, homeNone()))._id);
    assert.equal(await repair.repairSummaries(start), 1);
    const claim = { reason: LWD_REASON, lastSeenAt: at(26, 10), by: { id: NURSE.id, name: NURSE.name }, at: NOW };
    await m.DischargePlan.updateOne({ _id: planId }, { $set: { leftWithoutDischarge: claim } });
    await m.DischargeOrder.updateOne({ _id: id }, { $set: { state: 'left', leftAt: at(26, 10), leftBy: claim.by, endedAs: 'left-without-discharge' } });
    // Another stay: a crash after its bed was freed and its admission discharged, with no order.
    const other = await anotherStay('MHK202600923', 'Mary Jeni', 15);
    await m.DischargePlan.updateOne({ _id: other.planId }, { $set: { leftWithoutDischarge: { ...claim, at: at(26, 11, 2) } } });
    await m.Bed.updateOne({ _id: other.bedId }, { $set: { state: 'cleaning', admission: null } });
    await m.Admission.updateOne({ _id: other.admissionId }, { $set: { status: 'discharged', dischargedAt: at(26, 10), dischargedBy: NURSE.name } });
    sends = [];

    assert.equal(await repair.repairEndings(at(26, 11, 9), start), 0, 'under 10 minutes: perhaps still being recorded');
    assert.ok((await planOf()).leftWithoutDischarge);
    assert.equal(await repair.repairEndings(at(26, 11, 10), start), 1, 'the first claim is 10 minutes old');
    await flush();
    // Undone: the claim gone, the order back in progress, nothing announced or raised.
    const plan = await planOf();
    assert.deepEqual([plan.leftWithoutDischarge, plan.state], [undefined, 'ordered']);
    const row = await stored(id);
    assert.deepEqual([row.state, row.leftAt, row.endedAs], ['ordered', undefined, undefined]);
    assert.deepEqual([(await admissionOf()).status, (await bedOf()).state], ['active', 'occupied']);
    assert.equal(await m.Escalation.countDocuments({ 'source.kind': 'discharge-left' }), 0);

    // The second claim, once stale, is finished: the stay had ended.
    bedAnnounced = [];
    assert.equal(await repair.repairEndings(at(26, 11, 12), start), 1);
    await flush();
    const done = await planOf(other.planId);
    assert.deepEqual([done.state, done.completedKind, time(done.completedAt), !!done.leftWithoutDischarge.announcedAt], ['completed', 'left-without-discharge', at(26, 10).getTime(), true]);
    assert.equal((await patientOf(other.patientId)).status, 'Left without discharge');
    assert.deepEqual(bedAnnounced.map((c) => c.admissionId), [other.admissionId]);
    const esc = await m.Escalation.findOne({ 'source.kind': 'discharge-left', 'source.id': other.planId }).lean<any>();
    assert.equal(esc?.reason, 'Left without discharge — GWA-15');
    assert.deepEqual(sendsOf('discharge.completed').map((s) => [s.payload.orderId, s.payload.kind, s.key]), [['', 'left-without-discharge', `discharge.completed:plan:${other.planId}:resend`]]);
    assert.equal(await repair.repairEndings(at(26, 11, 12), start), 0);
    await quietSecondPass(at(26, 11, 12));
  });
});
