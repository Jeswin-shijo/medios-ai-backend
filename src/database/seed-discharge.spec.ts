import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { hourOf } from '../common/utils/series';
import { AppointmentEvents } from '../modules/appointments/appointment-events';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { ApprovalsService } from '../modules/coordinator/approvals.service';
import { ClocksService } from '../modules/coordinator/clocks.service';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { RulesService } from '../modules/coordinator/rules.service';
import { DischargeRepairService } from '../modules/discharge/discharge-repair.service';
import { DISCHARGE_START, DischargeScheduler } from '../modules/discharge/discharge.scheduler';
import { takeHomeOrderIds } from '../modules/discharge/schemas/discharge-order.schema';
import { OpdService } from '../modules/opd/opd.service';
import { medicineByKey } from '../modules/pharmacy/pharmacy-catalogue';
import { PriceListService } from '../modules/revenue/price-list.service';
import { RevenueBedDaysService } from '../modules/revenue/revenue-bed-days.service';
import { RevenueBillsService } from '../modules/revenue/revenue-bills.service';
import { RevenueCaptureService } from '../modules/revenue/revenue-capture.service';
import { RevenueCoordinatorRegistration } from '../modules/revenue/revenue-coordinator.registration';
import { CorrectionsService } from '../modules/revenue/revenue-corrections.service';
import { RevenueDepositsService } from '../modules/revenue/revenue-deposits.service';
import { RevenueEstimatesService } from '../modules/revenue/revenue-estimates.service';
import { FinalBillService } from '../modules/revenue/revenue-final.service';
import { RevenueOpdService } from '../modules/revenue/revenue-opd.service';
import { PaymentsService } from '../modules/revenue/revenue-payments.service';
import { RevenueReconcileService } from '../modules/revenue/revenue-reconcile.service';
import { RefundsService } from '../modules/revenue/revenue-refunds.service';
import { RevenueSettingsService } from '../modules/revenue/revenue-settings.service';
import { SchedulingConflictsService } from '../modules/scheduling/scheduling-conflicts.service';
import { SchedulingDoctorsService } from '../modules/scheduling/scheduling-doctors.service';
import { SchedulingRosterService } from '../modules/scheduling/scheduling-roster.service';
import { SchedulingSettingsService } from '../modules/scheduling/scheduling-settings.service';
import { SettingsService } from '../modules/settings/settings.service';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedDischarge, wire } from './seed-discharge';
import { seedEr } from './seed-er';
import { LAB_DEMO_ACCOUNTS, seedLab } from './seed-lab';
import { buildCounters, buildDepartments, buildDoctors } from './seed-opd';
import { seedPharmacy } from './seed-pharmacy';
import { seedRevenue } from './seed-revenue';
import { seedScheduling } from './seed-scheduling';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = '2026-09-26';
/** The real clock while seeding: Thursday 29 Oct 2026, 10:00 local. The clinic clock is 26 Sep 2026 at the same time. */
const NOW = new Date(2026, 9, 29, 10, 0, 0, 0).getTime();
/** Each later seed runs a few seconds after the one before, as in a real run. */
const GAP = 5_000;
/** The Discharge seed's own moment (real), and the clinic clock then. */
const SEED_NOW = NOW + 2 * GAP;
const CLINIC_NOW = new Date(2026, 8, 26, 10, 0, 10, 0);
const DAY_START = new Date(2026, 8, 26, 0, 0, 0, 0);
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'seed-data', `${name}.json`), 'utf8'));
const DAVID = 'MHK202500325';
const JAMES = 'MHK202500327';

describe('seedDischarge', () => {
  const m = models();
  const ids: Record<string, string> = {};
  let savedClinic: string | undefined;
  let log: string[] = [];
  /** The logins before the Discharge seed ran (Scheduling adds the doctors'). */
  let usersBefore = 0;

  /** Quiet console while seeding; returns what was logged. */
  const quiet = async (work: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const real = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.join(' '));
    };
    try {
      await work();
    } finally {
      console.log = real;
    }
    return lines;
  };

  /** The fixtures seed.ts replaces before the agent seeds: a reseed starts from the same patients, appointments and records. */
  const fixtures = async () => {
    await Promise.all([m.Patient, m.Appointment, m.Prescription, m.ClinicalDocument, m.TimelineEvent].map((x: any) => x.deleteMany({}).exec()));
    await m.Patient.insertMany(fixture('patients'));
    await m.Appointment.insertMany(fixture('appointments'));
    await m.Prescription.insertMany(fixture('prescriptions'));
    await m.ClinicalDocument.insertMany(fixture('documents'));
    await m.TimelineEvent.insertMany(fixture('timeline'));
  };

  /** Every agent seed before Discharge, in seed.ts's order, from `nowMs` on (Revenue a few seconds later). */
  const theRest = async (nowMs: number) => {
    mock.timers.setTime(nowMs);
    await quiet(async () => {
      await seedBeds(DAY);
      await seedCoordinator(DAY, nowMs);
      await seedEr(DAY, nowMs);
      await seedLab(DAY, nowMs);
      await seedPharmacy(DAY, nowMs);
      await seedScheduling(DAY, nowMs);
    });
    mock.timers.setTime(nowMs + GAP);
    await quiet(() => seedRevenue(DAY, nowMs + GAP));
  };

  /** Runs the Discharge seed at `nowMs` without CLINIC_DATE (the seed must not depend on it); returns its log. */
  const runSeed = async (nowMs: number): Promise<string[]> => {
    delete process.env.CLINIC_DATE;
    mock.timers.setTime(nowMs);
    try {
      return await quiet(() => seedDischarge(DAY, nowMs));
    } finally {
      process.env.CLINIC_DATE = DAY;
    }
  };

  const patient = async (uhid: string) => (await m.Patient.findOne({ uhid }).lean<any>().exec())!;
  const planOf = async (uhid: string) => (await m.DischargePlan.findOne({ patient: (await patient(uhid))._id }).lean<any>().exec())!;
  const lineStates = (order: any) => Object.fromEntries(order.lines.map((l: any) => [l.key, l.state]));
  const lineOf = (order: any, key: string) => order.lines.find((l: any) => l.key === key);
  const time = (d: unknown) => (d ? new Date(d as string).getTime() : null);

  /** The Revenue agent wired to the test database, as the module wires it, for its reconcile pass. */
  const revenueWorld = async () => {
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    const approvals = new ApprovalsService(m.Approval, m.DutyTitle, registry, messages, events);
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new RevenueSettingsService(settingsService);
    const rules = new RulesService(registry, settingsService, events);
    const reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    const bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient, undefined, m.Admission);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    const capture = new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    const final = new FinalBillService(messages, reg, settings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment, m.DischargeOrder);
    const payments = new PaymentsService(reg, settings, bills, final, m.Payment);
    const opd = new RevenueOpdService(new AppointmentEvents(), prices, bills, m.Appointment, m.Patient, m.ChargeLine, final);
    const estimates = new RevenueEstimatesService(reg, settings, prices, m.Bill, m.Estimate, m.ProcedureBooking, m.Admission, m.Bed);
    const deposits = new RevenueDepositsService(messages, reg, rules, settings, prices, bills, estimates, m.Bill, m.TaskAlertItem, m.ProcedureBooking, m.Admission, m.Bed, m.Ward, m.Case);
    const bedDays = new RevenueBedDaysService(messages, prices, bills, reg, m.Admission, m.Bed, m.Case, m.Bill, m.ChargeLine, estimates, deposits, final, settings, m.DischargeOrder);
    const refunds = new RefundsService(reg, settings, bills, approvals, final, m.Refund, m.TaskAlertItem);
    new CorrectionsService(reg, bills, approvals, final, prices, capture, m.Correction, m.ChargeLine);
    reg.onModuleInit();
    return new RevenueReconcileService(
      reg, bills, final, payments, estimates, deposits, refunds, capture, bedDays, opd,
      m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.TaskAlertItem, m.Clock,
      m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.Admission, m.DischargeOrder,
    );
  };

  before(async () => {
    await connectTestDb();
    await resetTestDb();
    Logger.overrideLogger(false);
    savedClinic = process.env.CLINIC_DATE;
    delete process.env.CLINIC_DATE;
    mock.timers.enable({ apis: ['Date'], now: NOW });

    for (const [key, email, name, role, department] of [
      ['admin', 'admin@medios.ai', 'Hospital Admin', 'admin', 'Administration'],
      ['doctor', 'doctor@medios.ai', 'Dr. Shajin', 'doctor', 'General Medicine'],
      ['nurse', 'nurse@medios.ai', 'Nurse Anjali Thomas', 'nurse', 'Nursing'],
      ['pharmacist', 'pharmacy@medios.ai', 'Neethu George', 'pharmacist', 'Pharmacy'],
      ['lab', 'lab@medios.ai', 'Vishnu Prasad', 'lab', 'Laboratory'],
      ['desk', 'frontdesk@medios.ai', 'Front Desk', 'staff', 'Reception'],
    ] as const) ids[key] = String((await m.User.create({ email, passwordHash: 'x', name, role, department }))._id);
    const path = LAB_DEMO_ACCOUNTS[0];
    await m.User.create({ email: path.email, passwordHash: 'x', name: path.name, role: path.role, department: path.department });
    const departments = buildDepartments();
    const doctors = buildDoctors(departments);
    await m.Department.insertMany(departments);
    const saved = await m.OpDoctor.insertMany(doctors.map((d) => ({ ...d, ...(d.name === 'Dr. Shajin' && { userId: ids.doctor }) })));
    ids.shajin = String(saved.find((d: any) => d.name === 'Dr. Shajin')!._id);
    const settings = fixture('settings');
    settings.queue = { ...settings.queue, counters: buildCounters(doctors) };
    settings.reception = { ...settings.reception, defaultDoctorId: ids.shajin };
    await m.HospitalSettings.create(settings);
    await fixtures();
    await theRest(NOW);
    usersBefore = await m.User.countDocuments().exec();
    log = await runSeed(SEED_NOW);
  });

  after(async () => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
    await closeTestDb();
  });

  test("David Raj is ordered Home with 5 of 7 done, waiting on teaching and bill", async () => {
    const david = await patient(DAVID);
    const plan = await planOf(DAVID);
    // A14: his target moved from admission + 5 days to the clinic day, by the demo doctor.
    assert.deepEqual([plan.targetDay, plan.state], [DAY, 'ordered']);
    assert.equal(plan.targetLog.length, 1);
    assert.deepEqual([plan.targetLog[0].from, plan.targetLog[0].to, plan.targetLog[0].by.name], ['2026-09-29', DAY, 'Dr. Shajin']);
    const order = (await m.DischargeOrder.findById(plan.order).lean<any>().exec())!;
    assert.deepEqual([order.kind, order.state, order.orderedBy.name, order.orderedBy.id], ['home', 'ordered', 'Dr. Shajin', ids.doctor]);
    assert.equal(time(order.orderedAt), CLINIC_NOW.getTime() - 65 * MIN, 'ordered 65 minutes before now');
    assert.ok(order.windowOpenedAt, 'the window is open');
    assert.ok(time(order.windowAt)! <= CLINIC_NOW.getTime());
    assert.deepEqual(lineStates(order), {
      order: 'done', summary: 'done', lab: 'done', 'take-home': 'done', 'follow-up': 'done', teaching: 'waiting', bill: 'waiting',
    });
    const w = wire();
    const progress = (await w.overview.patientLine(String(david._id)))!;
    assert.deepEqual([progress.status, progress.done, progress.required], ['ordered', 5, 7]);

    // Lab: LR-0016's two received tests follow up later, so the line is green.
    const lr16 = (await m.LabRequest.findOne({ number: 'LR-0016' }).lean<any>().exec())!;
    assert.deepEqual(order.followUpLater, [String(lr16._id)]);
    assert.match(lineOf(order, 'lab').detail, /2 results to follow up later/);
    assert.deepEqual((await m.LabLine.find({ request: lr16._id }).lean<any[]>().exec()).map((l) => l.status), ['received', 'received']);

    // Two take-home medicines, neither on his other active lines nor of their classes, placed, approved and issued from stock.
    const takeHome = takeHomeOrderIds(order);
    assert.equal(takeHome.length, 1);
    const thOrder = (await m.PharmacyOrder.findById(takeHome[0]).lean<any>().exec())!;
    assert.deepEqual([thOrder.takeHome, thOrder.setting, String(thOrder.case)], [true, 'Ward', String(plan.case)]);
    const thLines = await m.PharmacyLine.find({ order: thOrder._id }).lean<any[]>().exec();
    assert.equal(thLines.length, 2);
    for (const l of thLines) {
      assert.equal(l.status, 'issued', l.medicine);
      assert.equal(l.issued.store, 'main');
      assert.ok(!(l.flags ?? []).some((f: any) => f.severity === 'red'), `${l.medicine} has no red flag`);
      assert.ok(await m.PharmacyMovement.exists({ line: l._id, kind: 'issued' }).exec(), `${l.medicine} came out of stock`);
    }
    const others = await m.PharmacyLine.find({ patient: david._id, order: { $ne: thOrder._id }, status: { $in: ['to-check', 'query', 'approved', 'issued'] } }).lean<any[]>().exec();
    assert.ok(others.length >= 3, 'his OPD medicines stay as seeded');
    const otherClasses = new Set(others.map((l) => medicineByKey(l.medicine)!.classKey));
    for (const l of thLines) {
      assert.ok(!others.some((o) => o.medicine === l.medicine), `${l.medicine} is not on his lines`);
      assert.ok(!otherClasses.has(medicineByKey(l.medicine)!.classKey), `${l.medicine} is not of their classes`);
    }

    // The follow-up: booked in 7 days with the demo doctor.
    assert.equal(order.followUp.status, 'booked');
    const appt = (await m.Appointment.findById(order.followUp.appointmentId).lean<any>().exec())!;
    assert.equal(String(appt.doctorId), ids.shajin);
    assert.ok(appt.date >= '2026-10-03' && appt.date <= '2026-10-10', appt.date);
    assert.equal((await m.FollowUpItem.findById(order.followUp.followUpId).lean<any>().exec())!.status, 'Scheduled');

    // The summary: drafted, then signed by the demo doctor (A15: a Signed Documents record on the clinic clock).
    const summary = (await m.DischargeSummary.findOne({ order: order._id }).lean<any>().exec())!;
    assert.equal(summary.signedBy.name, 'Dr. Shajin');
    const doc = (await m.ClinicalDocument.findById(summary.documentId).lean<any>().exec())!;
    assert.deepEqual([doc.uhid, doc.status, doc.category, doc.title, doc.date], [DAVID, 'Signed', 'Discharge Summary', 'Discharge summary', '26 Sep 2026']);

    // His bill stays as seedRevenue left it: open, the final bill asked for, one line needing a price; so the bill line waits.
    const bill = (await m.Bill.findOne({ kind: 'admission', admission: order.admission }).lean<any>().exec())!;
    assert.equal(bill.state, 'open');
    assert.equal(await m.ChargeLine.countDocuments({ bill: bill._id, needsPrice: true }).exec(), 1);
    assert.match(lineOf(order, 'bill').detail, /1 line needs a price/);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `revenue-bill:${bill._id}:final` }).exec(), 1);
    // His paged consult stays as seeded.
    assert.equal((await m.ConsultRequest.findOne({ number: 'CO-0003' }).lean<any>().exec())!.status, 'paged');

    // The window opened on a signed summary: the leaving clock runs, and no summary clock started.
    const leave = (await m.Clock.findOne({ def: 'discharge-leave', ref: String(order._id) }).lean<any>().exec())!;
    assert.equal(leave.state, 'running');
    assert.ok(leave.dueAt.getTime() > SEED_NOW, 'not yet due');
    assert.equal(await m.Clock.countDocuments({ def: 'discharge-summary', ref: String(order._id) }).exec(), 0);
    assert.match(log.join('\n'), /✅ Discharge/);
  });

  test('the queue has every state listed', async () => {
    const w = wire();
    const rows = await w.overview.queue();
    const shape = rows.map((r: any) => `${r.status}:${r.kind ?? '-'}:${r.waitingKey ?? '-'}`).sort();
    assert.deepEqual(shape, [
      'due-today:-:order',
      'due-tomorrow:-:order',
      'ordered:home:summary',
      'ordered:home:take-home',
      'ordered:home:teaching',
      'ordered:transfer:summary',
      'overdue:-:order',
      'planned:-:order',
      'ready:home:-',
    ]);
    // James Wilson keeps his plan as computed: admission + expected stay.
    const james = rows.find((r: any) => r.patient.uhid === JAMES)!;
    assert.deepEqual([james.status, james.targetDay], ['planned', '2026-09-29']);
    // Ready to leave: the bill is settled and no gate pass is printed yet.
    const ready = rows.find((r: any) => r.status === 'ready')!;
    assert.equal(ready.done, ready.required);
    const readyOrder = (await m.DischargeOrder.findById(ready.orderId).lean<any>().exec())!;
    assert.equal(readyOrder.gatePass, undefined);
    assert.equal(lineOf(readyOrder, 'bill').detail, 'Bill settled');
    assert.equal((await m.Bill.findOne({ kind: 'admission', admission: readyOrder.admission }).lean<any>().exec())!.state, 'settled');
    // Take-home not issued: the medicines are approved and wait in Pharmacy.
    const waiting = rows.find((r: any) => r.waitingKey === 'take-home')!;
    assert.match(waiting.waitingDetail, /waiting in Pharmacy/);
    const thOrder = (await m.DischargeOrder.findById(waiting.orderId).lean<any>().exec())!;
    const thLines = await m.PharmacyLine.find({ order: { $in: takeHomeOrderIds(thOrder) } }).lean<any[]>().exec();
    assert.ok(thLines.length >= 1 && thLines.every((l) => l.status === 'approved'));
    // The transfer's letter and one Home summary wait for a signature, with their summary clocks running.
    for (const r of rows.filter((x: any) => x.waitingKey === 'summary')) {
      const summary = (await m.DischargeSummary.findOne({ order: r.orderId }).lean<any>().exec())!;
      assert.ok(summary, `${r.kind} summary drafted`);
      assert.equal(summary.signedAt, undefined);
      const clock = (await m.Clock.findOne({ def: 'discharge-summary', ref: r.orderId }).lean<any>().exec())!;
      assert.equal(clock?.state, 'running', `${r.kind} summary clock`);
      assert.ok(clock.dueAt.getTime() > SEED_NOW);
    }
    const transfer = (await m.DischargeOrder.findById(rows.find((r: any) => r.kind === 'transfer')!.orderId).lean<any>().exec())!;
    assert.ok(transfer.receivingHospital && transfer.transferReason);
    // Every order's leaving clock is still running: none is due at the seed's moment.
    for (const r of rows.filter((x: any) => x.orderId)) {
      const clock = (await m.Clock.findOne({ def: 'discharge-leave', ref: r.orderId }).lean<any>().exec())!;
      assert.equal(clock?.state, 'running', `${r.status} ${r.kind} leaving clock`);
      assert.ok(clock.dueAt.getTime() > SEED_NOW, `${r.status} ${r.kind} not yet due`);
    }
    // Every stay is a real admission in a general or private bed; no death in the demo.
    assert.equal(await m.DischargeOrder.countDocuments({ kind: 'died' }).exec(), 0);
    for (const r of rows) {
      const plan = (await m.DischargePlan.findById(r.planId).lean<any>().exec())!;
      const admission = (await m.Admission.findById(plan.admission).lean<any>().exec())!;
      assert.equal(admission.status, 'active');
      assert.notEqual(admission.sample, true);
      const bed = (await m.Bed.findById(admission.bed).lean<any>().exec())!;
      assert.equal(String(bed.admission), String(admission._id));
      const ward = (await m.Ward.findById(bed.ward).lean<any>().exec())!;
      if (r.patient.uhid !== JAMES) assert.ok(['general', 'private'].includes(ward.type), `${bed.label} is ${ward.type}`);
    }
    // 167 hourly history rows and this hour's live one, every count set (Beds freeing included).
    const snaps = await m.DischargeSnapshot.find().sort({ at: 1 }).lean<any[]>().exec();
    assert.equal(snaps.length, 168);
    assert.equal(snaps.at(-1)!.at.getTime(), hourOf(new Date(SEED_NOW)).getTime());
    assert.equal(snaps[0].at.getTime(), snaps.at(-1)!.at.getTime() - 167 * HOUR);
    for (const s of snaps) {
      for (const k of ['dueToday', 'noOrder', 'clearing', 'ready', 'leftToday', 'bedsFreeing']) assert.ok(Number.isInteger(s.counts[k]) && s.counts[k] >= 0, k);
      assert.ok(s.counts.bedsFreeing >= s.counts.leftToday, 'beds freeing counts the stays that ended');
    }
    assert.deepEqual([snaps.at(-1)!.counts.clearing, snaps.at(-1)!.counts.ready, snaps.at(-1)!.counts.leftToday], [4, 1, 3]);
  });

  test('two Home and one Against advice left today, one over target; each has endedAs', async () => {
    const w = wire();
    const left = await w.overview.leftToday();
    assert.deepEqual(left.map((r: any) => r.kind).sort(), ['against-advice', 'home', 'home']);
    assert.equal(left.filter((r: any) => r.overTarget).length, 1);
    assert.equal(left.find((r: any) => r.overTarget)!.kind, 'home');
    const numbers: string[] = [];
    for (const r of left) {
      const order = (await m.DischargeOrder.findById(r.orderId).lean<any>().exec())!;
      assert.deepEqual([order.state, order.endedAs], ['left', order.kind], `${r.kind} ended as its own kind`);
      assert.ok(r.minutes !== null && r.minutes > 0, 'timed');
      assert.ok(time(order.leftAt)! >= DAY_START.getTime() && time(order.leftAt)! < CLINIC_NOW.getTime(), 'left earlier today');
      assert.ok(order.gatePass?.number, 'a gate pass was printed');
      assert.ok(time(order.gatePass.printedAt[0])! <= time(order.leftAt)!, 'the pass came first');
      numbers.push(order.gatePass.number);
      assert.ok(order.announced.includes('discharge.completed'));
      const plan = (await m.DischargePlan.findById(order.plan).lean<any>().exec())!;
      assert.deepEqual([plan.state, plan.completedKind, time(plan.completedAt)], ['completed', order.kind, time(order.leftAt)]);
      const admission = (await m.Admission.findById(order.admission).lean<any>().exec())!;
      assert.deepEqual([admission.status, time(admission.dischargedAt)], ['discharged', time(order.leftAt)]);
      assert.equal((await m.Bed.findById(admission.bed).lean<any>().exec())!.state, 'cleaning');
      assert.equal((await m.Patient.findById(order.patient).lean<any>().exec())!.status, 'Discharged');
      const bills = await m.Bill.find({ kind: 'admission', admission: order.admission }).lean<any[]>().exec();
      assert.equal(bills.length, 1);
      assert.deepEqual([bills[0].state, bills[0].totals.balance], ['settled', 0]);
      assert.equal(lineOf(order, 'bill').state, 'done');
    }
    assert.deepEqual(numbers.sort(), ['GP-0001', 'GP-0002', 'GP-0003']);
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'discharge-gatepass' }).lean<any>().exec())!.last, 3);
    // The agent's status agrees: two of the three left within the target.
    const status = await w.registry.get('discharge')!.status();
    assert.deepEqual([status.open, status.onTimePct], [5, 67]);
  });

  test('the reminder alert exists for the due-today stay', async () => {
    const w = wire();
    const dueToday = (await w.overview.queue({ status: 'due-today' })) as any[];
    assert.equal(dueToday.length, 1);
    const plan = (await m.DischargePlan.findById(dueToday[0].planId).lean<any>().exec())!;
    assert.equal(plan.remindedDay, DAY);
    const reminder = (await m.TaskAlertItem.findOne({ link: `discharge-plan:${plan._id}:reminder` }).lean<any>().exec())!;
    assert.ok(reminder, 'a reminder');
    assert.deepEqual([reminder.status, reminder.title, reminder.priority, reminder.category], ['Pending', `Discharge due today, no order yet: ${plan.bedLabel}`, 'Medium', 'Follow-up']);
    assert.equal(reminder.subtitle, `For ${plan.doctor} · give the discharge order, or move the target date`);
    // The only open reminder: every other plan due today has an order.
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^discharge-plan:.*:reminder$/, status: { $ne: 'Completed' } }).exec(), 1);
  });

  test('ward-nurse-in-charge is held by the demo nurse and seed-scheduling still has exactly its two conflicts', async () => {
    const title = (await m.DutyTitle.findOne({ key: 'ward-nurse-in-charge' }).lean<any>().exec())!;
    assert.deepEqual(title.holders.map(String), [ids.nurse]);
    // No new logins.
    assert.equal(await m.User.countDocuments().exec(), usersBefore);
    // The Scheduling conflict sweep over the seeded hospital still finds only its two (no roster gap for the new title).
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    const settingsService = new SettingsService(m.HospitalSettings);
    const roster = new SchedulingRosterService(m.StaffMember, m.RosterEntry, new SchedulingSettingsService(settingsService), escalations);
    roster.onModuleInit();
    const doctors = new SchedulingDoctorsService(m.DoctorProfile, m.Appointment, new OpdService(m.Department, m.OpDoctor, settingsService));
    const conflicts = new SchedulingConflictsService(m.Appointment, m.ProcedureBooking, m.RoomBlock, m.OpDoctor, m.StaffMember, m.WaitItem, m.TaskAlertItem, doctors, roster, escalations);
    const found = await conflicts.sweep();
    assert.deepEqual(found.map((c: any) => c.kind).sort(), ['room-blocked', 'running-late']);
    const open = await m.TaskAlertItem.find({ link: /^scheduling-conflict:/, status: { $ne: 'Completed' } }).lean<any[]>().exec();
    assert.deepEqual(open.map((c) => c.link.split(':')[1]).sort(), ['room-blocked', 'running-late']);
  });

  test('no Discharge record names a patient in a message summary', async () => {
    const names = (await m.Patient.find().select('name').lean<any[]>().exec()).map((p) => p.name as string).filter((n) => n && n.length >= 4);
    const messages = await m.AgentMessage.find({ from: 'discharge' }).lean<any[]>().exec();
    assert.ok(messages.length >= 40, `${messages.length} discharge messages`);
    const alerts = await m.TaskAlertItem.find({ link: /^discharge-/ }).lean<any[]>().exec();
    const clocks = await m.Clock.find({ def: /^discharge-/ }).lean<any[]>().exec();
    assert.ok(clocks.length >= 8, `${clocks.length} discharge clocks`);
    const hay = (text: string) => text.toLowerCase();
    for (const msg of messages) {
      const text = hay(`${msg.summary} ${JSON.stringify(msg.payload ?? {})}`);
      for (const n of names) assert.ok(!text.includes(n.toLowerCase()), `${msg.type} names ${n}: ${msg.summary}`);
      assert.ok(msg.summary.length <= 140, msg.summary);
      assert.match(msg.summary, /^.+: .+ \((Home|Transfer|Against advice)\)$|^.+: Discharge (planned for|target moved to) \d{1,2} \w{3} \d{4}$/, msg.summary);
    }
    for (const a of alerts) {
      const text = hay(`${a.title} ${a.subtitle ?? ''}`);
      for (const n of names) assert.ok(!text.includes(n.toLowerCase()), `${a.link} names ${n}: ${a.title}`);
    }
    for (const c of clocks) {
      const text = hay(c.detail ?? '');
      for (const n of names) assert.ok(!text.includes(n.toLowerCase()), `${c.def} names ${n}: ${c.detail}`);
    }
  });

  test('every seeded open order and plan carries in announced each message its state says went', async () => {
    const orders = await m.DischargeOrder.find().lean<any[]>().exec();
    assert.equal(orders.length, 8);
    for (const o of orders) {
      const want = ['discharge.ordered'];
      if (o.windowOpenedAt) want.push('discharge.window-opened');
      const summary = await m.DischargeSummary.findOne({ order: o._id }).lean<any>().exec();
      if (summary?.signedAt) want.push('discharge.summary-signed');
      if (o.state === 'ready' || o.state === 'left') want.push('discharge.ready');
      if (o.state === 'left') want.push('discharge.completed');
      for (const type of want) {
        assert.ok(o.announced.includes(type), `${o.kind} ${o.state}: ${type} in announced (${o.announced})`);
        assert.ok(await m.AgentMessage.exists({ type, 'payload.orderId': String(o._id) }).exec(), `${type} went for ${o.kind} ${o.state}`);
      }
      // Every window message says whether the summary was signed (R20); a signed one started no summary clock.
      const opened = (await m.AgentMessage.findOne({ type: 'discharge.window-opened', 'payload.orderId': String(o._id) }).lean<any>().exec())!;
      assert.equal(typeof opened.payload.summarySigned, 'boolean');
      const summaryClocks = await m.Clock.countDocuments({ def: 'discharge-summary', ref: String(o._id) }).exec();
      assert.equal(summaryClocks, opened.payload.summarySigned ? 0 : 1, `${o.kind} ${o.state} summary clock`);
    }
    const plans = await m.DischargePlan.find().lean<any[]>().exec();
    assert.equal(plans.length, 12);
    for (const p of plans) {
      if (p.state !== 'completed') assert.ok(p.announcedAt, `plan ${p.bedLabel} announced`);
      assert.ok(await m.AgentMessage.exists({ type: 'discharge.planned', 'payload.planId': String(p._id) }).exec(), `discharge.planned for ${p.bedLabel}`);
    }
  });

  test("Revenue's reconcile window starts after the Discharge records", async () => {
    const newest = async (model: any) => {
      const rows = await model.find().select('createdAt updatedAt').lean().exec();
      return Math.max(0, ...rows.flatMap((r: any) => [time(r.createdAt) ?? 0, time(r.updatedAt) ?? 0]));
    };
    const latest = Math.max(
      await newest(m.DischargePlan), await newest(m.DischargeOrder), await newest(m.DischargeSummary), await newest(m.DischargeSnapshot),
      await newest(m.Bill), await newest(m.ChargeLine), await newest(m.Payment), await newest(m.PharmacyOrder), await newest(m.PharmacyLine), await newest(m.Admission),
    );
    assert.ok(latest >= SEED_NOW, 'the newest record is the seed\'s own');
    const dischargeStart = (await m.CoordinatorCounter.findOne({ key: DISCHARGE_START }).lean<any>().exec())!.last;
    const revenueStart = (await m.CoordinatorCounter.findOne({ key: 'revenue-start' }).lean<any>().exec())!.last;
    assert.ok(dischargeStart > latest, `discharge-start ${dischargeStart} after the newest record ${latest}`);
    assert.ok(revenueStart > latest, `revenue-start ${revenueStart} after the newest record ${latest}`);
    // So Revenue's minute pass, eleven minutes on, back-bills, re-sends and repairs nothing.
    mock.timers.setTime(SEED_NOW + 11 * MIN);
    try {
      const reconcile = await revenueWorld();
      const snap = async () => ({
        messages: await m.AgentMessage.countDocuments().exec(),
        alerts: (await m.TaskAlertItem.find().sort({ _id: 1 }).lean<any[]>().exec()).map((a) => [String(a._id), a.link, a.status, a.title]),
        bills: (await m.Bill.find().sort({ _id: 1 }).lean<any[]>().exec()).map((b) => [String(b._id), b.state, JSON.stringify(b.totals)]),
        lines: await m.ChargeLine.countDocuments().exec(),
        clocks: (await m.Clock.find().sort({ _id: 1 }).lean<any[]>().exec()).map((c) => [String(c._id), c.state]),
      });
      const beforeRun = await snap();
      const result = await reconcile.reconcile();
      assert.deepEqual(result, { announced: 0, tasks: 0, charges: 0, totals: 0, reversals: 0, clocks: 0, bedDays: 0, opdFees: 0, settled: 0 });
      assert.deepEqual(await snap(), beforeRun, 'nothing new was sent or written');
    } finally {
      mock.timers.setTime(SEED_NOW);
    }
  });

  test('the first pass is quiet', async () => {
    // Eleven minutes on: past the repairs' 30-second and 10-minute graces, so only the start stamp keeps them off the seeded records.
    mock.timers.setTime(SEED_NOW + 11 * MIN);
    try {
      const w = wire();
      const repair = new DischargeRepairService(w.plans, w.orders, w.lines, w.summary, w.leaving, w.takeHome, m.DischargePlan, m.DischargeOrder, m.DischargeSummary, m.PharmacyOrder, m.PharmacyLine);
      const scheduler = new DischargeScheduler(w.plans, w.orders, w.lines, repair, w.overview, m.CoordinatorCounter);
      const snap = async () => ({
        messages: await m.AgentMessage.countDocuments({ from: 'discharge' }).exec(),
        orders: (await m.DischargeOrder.find().sort({ _id: 1 }).lean<any[]>().exec()).map((o) => [
          String(o._id), o.state, [...o.announced].sort().join(','), o.lines.map((l: any) => `${l.key}:${l.state}:${l.detail ?? ''}`).join('|'), time(o.windowOpenedAt), o.readyCount,
        ]),
        plans: (await m.DischargePlan.find().sort({ _id: 1 }).lean<any[]>().exec()).map((p) => [
          String(p._id), p.state, time(p.announcedAt), p.remindedDay ?? null, String(p.order ?? ''), time(p.endingCheckedAt), p.targetDay,
        ]),
        summaries: (await m.DischargeSummary.find().sort({ _id: 1 }).lean<any[]>().exec()).map((s) => [String(s._id), time(s.signedAt), s.documentId ?? null]),
        alerts: (await m.TaskAlertItem.find({ link: /^discharge-/ }).sort({ _id: 1 }).lean<any[]>().exec()).map((a) => [String(a._id), a.status, a.title]),
        clocks: (await m.Clock.find({ def: /^discharge-/ }).sort({ _id: 1 }).lean<any[]>().exec()).map((c) => [String(c._id), c.state]),
        snapshots: await m.DischargeSnapshot.countDocuments().exec(),
      });
      const beforeTick = await snap();
      await scheduler.tick();
      assert.deepEqual(await snap(), beforeTick, 'the first minute pass sent and changed nothing');
    } finally {
      mock.timers.setTime(SEED_NOW);
    }
  });

  test('running the seed twice gives the same counts', async () => {
    const counts = async () => {
      const orders = await m.DischargeOrder.find().lean<any[]>().exec();
      return {
        plans: await m.DischargePlan.countDocuments().exec(),
        orders: orders.map((o) => `${o.kind}:${o.state}`).sort(),
        summaries: await m.DischargeSummary.countDocuments().exec(),
        signed: await m.DischargeSummary.countDocuments({ signedAt: { $ne: null } }).exec(),
        documents: await m.ClinicalDocument.countDocuments({ category: 'Discharge Summary' }).exec(),
        timeline: await m.TimelineEvent.countDocuments({ title: /^(Discharge summary|Transfer letter|Against-advice note|Death summary) signed$/ }).exec(),
        snapshots: await m.DischargeSnapshot.countDocuments().exec(),
        messages: (await m.AgentMessage.find({ from: 'discharge' }).lean<any[]>().exec()).map((x) => x.type).sort(),
        clocks: (await m.Clock.find({ def: /^discharge-/ }).lean<any[]>().exec()).map((c) => `${c.def}:${c.state}`).sort(),
        alerts: await m.TaskAlertItem.countDocuments({ link: /^discharge-/ }).exec(),
        gatePasses: (await m.CoordinatorCounter.findOne({ key: 'discharge-gatepass' }).lean<any>().exec())?.last,
        admissions: await m.Admission.countDocuments({ sample: { $ne: true } }).exec(),
        patients: await m.Patient.countDocuments().exec(),
        users: await m.User.countDocuments().exec(),
      };
    };
    const first = await counts();
    // A reseed (seed.ts) replaces the fixtures, runs every agent seed again (each replaces its own records), then the Discharge seed.
    await fixtures();
    await theRest(NOW + 3 * GAP);
    await runSeed(NOW + 5 * GAP);
    try {
      assert.deepEqual(await counts(), first);
      const shape = ((await wire().overview.queue()) as any[]).map((r) => `${r.status}:${r.kind ?? '-'}:${r.waitingKey ?? '-'}`).sort();
      assert.equal(shape.length, 9);
    } finally {
      mock.timers.setTime(SEED_NOW);
    }
  });
});
