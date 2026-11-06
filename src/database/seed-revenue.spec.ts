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
import { LAB_TESTS } from '../modules/lab/lab-catalogue';
import { MEDICINES } from '../modules/pharmacy/pharmacy-catalogue';
import { PriceListService } from '../modules/revenue/price-list.service';
import { RevenueBedDaysService } from '../modules/revenue/revenue-bed-days.service';
import { RevenueBillsService, lineTotals } from '../modules/revenue/revenue-bills.service';
import { RevenueCaptureService } from '../modules/revenue/revenue-capture.service';
import { RevenueCoordinatorRegistration } from '../modules/revenue/revenue-coordinator.registration';
import { RevenueDepositsService } from '../modules/revenue/revenue-deposits.service';
import { RevenueEstimatesService } from '../modules/revenue/revenue-estimates.service';
import { FinalBillService } from '../modules/revenue/revenue-final.service';
import { RevenueOpdService } from '../modules/revenue/revenue-opd.service';
import { PaymentsService } from '../modules/revenue/revenue-payments.service';
import { RevenueReconcileService } from '../modules/revenue/revenue-reconcile.service';
import { RefundsService } from '../modules/revenue/revenue-refunds.service';
import { RevenueSettingsService } from '../modules/revenue/revenue-settings.service';
import { CorrectionsService } from '../modules/revenue/revenue-corrections.service';
import { PROCEDURES } from '../modules/scheduling/scheduling-catalogue';
import { SettingsService } from '../modules/settings/settings.service';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedEr } from './seed-er';
import { LAB_DEMO_ACCOUNTS, seedLab } from './seed-lab';
import { buildCounters, buildDepartments, buildDoctors } from './seed-opd';
import { seedPharmacy } from './seed-pharmacy';
import { PRICELESS_CODES, seedRevenue } from './seed-revenue';
import { seedScheduling } from './seed-scheduling';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;
const DAY = '2026-09-26';
/** The real clock while seeding: Thursday 29 Oct 2026, 10:00 local. The clinic clock is 26 Sep 2026 at the same time. */
const NOW = new Date(2026, 9, 29, 10, 0, 0, 0).getTime();
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'seed-data', `${name}.json`), 'utf8'));

describe('seedRevenue', () => {
  const m = models();
  const ids: Record<string, string> = {};
  let savedClinic: string | undefined;
  let log: string[] = [];
  /** The Revenue seed runs a moment after the other seeds (a real run takes seconds), so their records are older than the start time (R36). */
  const GAP = 5_000;

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

  /** The Revenue agent wired to the test database, as the module wires it, for the reconcile pass. */
  const reconcileWorld = async () => {
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
    const reconcile = new RevenueReconcileService(
      reg, bills, final, payments, estimates, deposits, refunds, capture, bedDays, opd,
      m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.TaskAlertItem, m.Clock,
      m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.Admission, m.DischargeOrder,
    );
    return { reconcile, bedDays, registry };
  };

  const billOf = async (uhid: string, kind?: string) => {
    const patient = (await m.Patient.findOne({ uhid }).lean<any>().exec())!;
    return (await m.Bill.findOne({ patient: patient._id, ...(kind ? { kind } : {}) }).lean<any>().exec())!;
  };
  const mohan = async () => {
    const visit = (await m.ErVisit.find().lean<any[]>().exec()).find((v) => /Pressure in the chest/.test(v.complaintText ?? ''))!;
    return { visit, patient: (await m.Patient.findById(visit.patient).lean<any>().exec())! };
  };
  const taskOf = (link: string) => m.TaskAlertItem.findOne({ link }).lean<any>().exec();

  /** The hospital as the main seed leaves it before seedRevenue: users, OP doctors, settings, fixtures, then every other agent. */
  const seedTheRest = async (nowMs: number) => {
    await quiet(async () => {
      await seedEr(DAY, nowMs);
      await seedLab(DAY, nowMs);
      await seedPharmacy(DAY, nowMs);
    });
  };

  before(async () => {
    await connectTestDb();
    await resetTestDb();
    Logger.overrideLogger(false);
    savedClinic = process.env.CLINIC_DATE;
    // The seed does not read .env: it must not depend on CLINIC_DATE.
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
    await m.Patient.insertMany(fixture('patients'));
    await m.Appointment.insertMany(fixture('appointments'));
    await m.Prescription.insertMany(fixture('prescriptions'));
    await quiet(async () => {
      await seedBeds(DAY);
      await seedCoordinator(DAY, NOW);
    });
    await seedTheRest(NOW);
    await quiet(() => seedScheduling(DAY, NOW));
    // A few seconds on, as in a real run.
    mock.timers.setTime(NOW + GAP);
    log = await quiet(() => seedRevenue(DAY, NOW + GAP));
    process.env.CLINIC_DATE = DAY;
  });

  after(async () => {
    mock.timers.reset();
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
    await closeTestDb();
  });

  test('the price list covers every Lab test, Pharmacy product and procedure', async () => {
    const items = await m.PriceItem.find().lean<any[]>().exec();
    const byCode = new Map(items.map((i) => [i.code, i]));
    for (const code of ['er:registration', 'er:doctor', 'consult:stat', 'consult:urgent', 'consult:routine', 'nursing:general', 'nursing:private', 'nursing:critical', 'cons:stent-des', 'cons:guide-wire', 'cons:iv-set']) {
      assert.ok(byCode.has(code), code);
    }
    assert.deepEqual(
      ['er:registration', 'er:doctor', 'consult:stat', 'consult:urgent', 'consult:routine', 'nursing:general', 'nursing:private', 'nursing:critical', 'cons:stent-des', 'cons:guide-wire', 'cons:iv-set'].map((c) => byCode.get(c).price),
      [300, 800, 1500, 1000, 700, 800, 1200, 3000, 38000, 3500, 150],
    );
    assert.equal(LAB_TESTS.length, 15);
    for (const t of LAB_TESTS) {
      const item = byCode.get(`lab:${t.key}`);
      assert.ok(item, `lab:${t.key}`);
      assert.equal(item.category, 'lab');
      if (!(PRICELESS_CODES as readonly string[]).includes(`lab:${t.key}`)) assert.ok(item.price >= 150 && item.price <= 1200, `${t.key} ₹${item.price}`);
    }
    const products = MEDICINES.flatMap((x) => x.products);
    assert.equal(products.length, 75);
    for (const p of products) {
      const item = byCode.get(`med:${p.key}`);
      assert.ok(item, `med:${p.key}`);
      assert.equal(item.unit, p.issueUnit);
      if (!(PRICELESS_CODES as readonly string[]).includes(`med:${p.key}`)) assert.ok(item.price >= 2 && item.price <= 4500, `${p.key} ₹${item.price}`);
    }
    assert.equal(PROCEDURES.length, 12);
    for (const p of PROCEDURES) assert.ok(byCode.has(`proc:${p.key}`), `proc:${p.key}`);
    assert.equal(byCode.get('proc:coronary-angiography').price, 18000);
    assert.equal(byCode.get('proc:coronary-angioplasty').price, 145000);
    for (const k of ['chest-xray', 'ct-head', 'ct-abdomen-contrast', 'ultrasound-abdomen', 'echocardiogram']) {
      const p = byCode.get(`proc:${k}`);
      assert.ok(p.price >= 400 && p.price <= 4500, `${k} ₹${p.price}`);
    }
    // Two codes have no price, on purpose.
    assert.deepEqual(items.filter((i) => i.price === 0).map((i) => i.code).sort(), [...PRICELESS_CODES].sort());
    assert.match(log.join('\n'), /✅ Revenue/);
  });

  test('Mohan Raj has an ER bill and an estimate but no deposit task', async () => {
    const { visit, patient } = await mohan();
    const bill = (await m.Bill.findOne({ patient: patient._id, kind: 'er' }).lean<any>().exec())!;
    assert.ok(bill, 'an ER bill');
    assert.deepEqual([bill.state, String(bill.erVisit), String(bill.case)], ['open', String(visit._id), String(visit.case)]);
    const lines = await m.ChargeLine.find({ bill: bill._id }).lean<any[]>().exec();
    assert.ok(lines.some((l) => l.code === 'er:registration'), 'ER registration');
    assert.ok(lines.some((l) => l.category === 'lab'), 'tests');
    assert.ok(lines.some((l) => l.category === 'pharmacy'), 'issued medicines');
    assert.equal(lines.filter((l) => l.needsPrice).length, 0, 'every line priced');
    assert.equal(bill.totals.charges, lines.reduce((s, l) => s + l.amount, 0));
    // The estimate comes from the angiography booked for him (₹18,000 package).
    const estimate = (await m.Estimate.findOne({ bill: bill._id }).lean<any>().exec())!;
    assert.ok(estimate, 'an estimate');
    assert.ok(estimate.lines.some((l: any) => /angiography/i.test(l.name) && l.amount === 18000), JSON.stringify(estimate.lines));
    assert.ok(estimate.low < estimate.high);
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.estimate-ready', 'payload.billId': String(bill._id) }).exec(), 1);
    // No deposit task and no deposit message while he is an emergency bill (A1).
    assert.equal(await taskOf(`revenue-bill:${bill._id}:deposit`), null);
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.deposit-due', 'payload.billId': String(bill._id) }).exec(), 0);
    assert.equal(bill.depositAsk, undefined);
  });

  test('James Wilson has a top-up task and a running top-up clock', async () => {
    const bill = await billOf('MHK202500327', 'admission');
    assert.ok(bill, 'an admission bill');
    assert.deepEqual([bill.state, bill.wardType], ['open', 'hdu']);
    const admission = (await m.Admission.findById(bill.admission).lean<any>().exec())!;
    // The bed days follow the service's started-period count since the seeded admission time (R3), not a fixed number.
    const clinicNow = new Date(2026, 8, 26, 10, 0, 5).getTime();
    let periods = 0;
    while (new Date(admission.admittedAt).getTime() + periods * DAY_MS <= clinicNow) periods++;
    assert.ok(periods >= 2);
    const bedDays = await m.ChargeLine.find({ bill: bill._id, 'source.type': 'bed-day' }).lean<any[]>().exec();
    assert.equal(bedDays.length, periods);
    assert.equal(await m.ChargeLine.countDocuments({ bill: bill._id, 'source.type': 'nursing-day' }).exec(), periods);
    const world = await reconcileWorld();
    assert.equal(await world.bedDays.chargeDue(String(admission._id)), 0, 'no day is missing or double');
    // The advance was paid, and the deposit task is done.
    const payments = await m.Payment.find({ bill: bill._id }).lean<any[]>().exec();
    assert.ok(payments.length >= 1 && payments.every((p) => /^RC-\d{4}$/.test(p.receiptNumber)));
    assert.equal((await taskOf(`revenue-bill:${bill._id}:deposit`))?.status, 'Completed');
    // The top-up is due: a pending task, a message and a running clock on the revenue ladder.
    const task = (await taskOf(`revenue-bill:${bill._id}:topup`))!;
    assert.ok(task, 'a top-up task');
    assert.equal(task.status, 'Pending');
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.topup-due', 'payload.billId': String(bill._id) }).exec(), 1);
    const clock = (await m.Clock.findOne({ def: 'revenue-topup', ref: String(bill._id) }).lean<any>().exec())!;
    assert.ok(clock, 'a top-up clock');
    assert.equal(clock.state, 'running');
    assert.ok(clock.dueAt.getTime() > Date.now(), 'not yet due');
    assert.ok(bill.totals.charges - bill.totals.discounts >= 0.8 * bill.totals.payments, 'charges have used 80% of the payments');
  });

  test("David Raj's final bill waits with a needs-price line", async () => {
    const bill = await billOf('MHK202500325', 'admission');
    assert.ok(bill, 'an admission bill');
    assert.equal(bill.state, 'open');
    assert.equal(bill.wardType, 'general');
    const unpriced = await m.ChargeLine.find({ bill: bill._id, needsPrice: true }).lean<any[]>().exec();
    assert.equal(unpriced.length, 1);
    assert.ok((PRICELESS_CODES as readonly string[]).includes(unpriced[0].code));
    assert.equal(unpriced[0].amount, 0);
    const task = (await taskOf(`revenue-bill:${bill._id}:final`))!;
    assert.ok(task, 'a final-bill task');
    assert.equal(task.status, 'Pending');
    assert.equal(await m.AgentMessage.countDocuments({ type: 'revenue.final-requested', 'payload.billId': String(bill._id) }).exec(), 1);
    const clock = (await m.Clock.findOne({ def: 'revenue-final', ref: String(bill._id) }).lean<any>().exec())!;
    assert.equal(clock?.state, 'running');
  });

  test('both admission bills carry the patient\'s ipd case, as a bed assignment gives them, and its Bill settled check fails while money is due', async () => {
    const { registry } = await reconcileWorld();
    const check = registry.closeChecks().find((c) => c.agent === 'revenue' && c.label === 'Bill settled')!;
    assert.ok(check, 'the Revenue close check');
    for (const [uhid, clockDef] of [['MHK202500327', 'revenue-topup'], ['MHK202500325', 'revenue-final']] as const) {
      const bill = await billOf(uhid, 'admission');
      assert.ok(bill.case, `${bill.number} has a case`);
      const c = (await m.Case.findById(bill.case).lean<any>().exec())!;
      assert.deepEqual([String(c.patient), c.kind, c.state], [String(bill.patient), 'ipd', 'open'], bill.number);
      assert.ok(c.agents.includes('bed'), `${bill.number} case joined by the bed agent`);
      assert.equal(String(c.refs?.admissionId), String(bill.admission), `${bill.number} case refers to the admission`);
      assert.equal(await m.Case.countDocuments({ patient: bill.patient, state: 'open' }).exec(), 1, `${bill.number}: one open case`);
      assert.ok(bill.totals.balance !== 0 || bill.state !== 'settled', `${bill.number} has money due`);
      assert.equal(await check.check(String(bill.case)), 'fail', `${bill.number} close check`);
      // Its messages and clocks carry the case, so the clock can be stopped and its escalation acknowledged.
      const sent = await m.AgentMessage.find({ from: 'revenue', 'payload.billId': String(bill._id) }).lean<any[]>().exec();
      assert.ok(sent.length >= 1, bill.number);
      for (const msg of sent) assert.equal(String(msg.case), String(bill.case), `${bill.number} ${msg.type}`);
      const clock = (await m.Clock.findOne({ def: clockDef, ref: String(bill._id) }).lean<any>().exec())!;
      assert.equal(String(clock.case), String(bill.case), `${bill.number} ${clockDef} clock`);
    }
  });

  test('bills in every state: settled with receipts, a refund due, a discount waiting, outpatients and a walk-in', async () => {
    const bills = await m.Bill.find().lean<any[]>().exec();
    assert.ok(bills.length >= 18 && bills.length <= 30, `${bills.length} bills`);
    assert.deepEqual([...new Set(bills.map((b) => b.kind))].sort(), ['admission', 'er', 'opd', 'walk-in']);
    for (const state of ['open', 'final', 'settled']) assert.ok(bills.some((b) => b.state === state), state);
    // Every bill's totals are what its records add up to.
    for (const b of bills) {
      const lines = await m.ChargeLine.find({ bill: b._id }).lean<any[]>().exec();
      const paid = (await m.Payment.find({ bill: b._id, cancelled: { $exists: false } }).lean<any[]>().exec()).reduce((s, p) => s + p.amount, 0);
      const expected = lineTotals(lines);
      assert.deepEqual([b.totals.charges, b.totals.discounts], [expected.charges, expected.discounts], `${b.number} lines`);
      assert.equal(b.totals.payments, paid, `${b.number} payments`);
      assert.equal(b.totals.balance, b.totals.charges - b.totals.discounts - b.totals.payments + b.totals.refunds, `${b.number} balance`);
    }
    // Three settled ER or admission bills with receipts; each settled at balance 0 (R21).
    const settled = bills.filter((b) => b.state === 'settled' && (b.kind === 'er' || b.kind === 'admission'));
    assert.equal(settled.length, 3);
    for (const b of settled) {
      assert.equal(b.totals.balance, 0, b.number);
      assert.ok(b.finalAt, `${b.number} was prepared first`);
      assert.ok((await m.Payment.countDocuments({ bill: b._id }).exec()) >= 1);
    }
    // One final bill with a refund due, approved and not paid (R25).
    const refunds = await m.Refund.find().lean<any[]>().exec();
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].state, 'approved');
    assert.match(refunds[0].number, /^RF-\d{4}$/);
    const refundBill = bills.find((b) => String(b._id) === String(refunds[0].bill))!;
    assert.deepEqual([refundBill.state, refundBill.totals.balance < 0], ['final', true]);
    assert.equal(refunds[0].amount, -refundBill.totals.balance);
    assert.equal((await taskOf(`revenue-refund:${refunds[0]._id}`))?.status, 'Pending');
    assert.equal((await m.Clock.findOne({ def: 'revenue-refund', ref: String(refunds[0]._id) }).lean<any>().exec())?.state, 'running');
    // One discount waiting for approval, asked for by the desk.
    const corrections = await m.Correction.find().lean<any[]>().exec();
    assert.equal(corrections.length, 1);
    assert.deepEqual([corrections[0].kind, corrections[0].state, corrections[0].requestedBy.name], ['discount', 'pending', 'Front Desk']);
    const approval = (await m.Approval.findById(corrections[0].approvalId).lean<any>().exec())!;
    assert.deepEqual([approval.type, approval.state], ['revenue.correction', 'open']);
    // Outpatient fees for the clinic day, two of them paid and settled once the visit was completed (R18, R20).
    const opd = bills.filter((b) => b.kind === 'opd');
    assert.ok(opd.length >= 6, `${opd.length} OPD bills`);
    const opdSettled = opd.filter((b) => b.state === 'settled');
    assert.equal(opdSettled.length, 2);
    for (const b of opdSettled) {
      assert.equal(b.totals.balance, 0);
      const a = (await m.Appointment.findById(b.appointment).lean<any>().exec())!;
      assert.equal(a.status, 'Completed');
    }
    for (const b of opd) assert.equal(b.day, DAY);
    // Fees follow the doctor.
    const fees = await m.ChargeLine.find({ 'source.type': 'opd-fee' }).lean<any[]>().exec();
    assert.ok(new Set(fees.map((f) => f.unitPrice)).size >= 2, 'fees differ by doctor');
    // One walk-in.
    assert.equal(bills.filter((b) => b.kind === 'walk-in').length, 1);
    // The counters follow the numbers used; the start time is stamped (R36).
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'revenue-bill' }).lean<any>().exec())!.last, bills.length);
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'revenue-receipt' }).lean<any>().exec())!.last, await m.Payment.countDocuments().exec());
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'revenue-start' }).lean<any>().exec())!.last, NOW + GAP);
    // The billing desk's title is held by the admin.
    const title = (await m.DutyTitle.findOne({ key: 'billing-in-charge' }).lean<any>().exec())!;
    assert.deepEqual(title.holders.map(String), [ids.admin]);
  });

  test('168 snapshots', async () => {
    const snaps = await m.RevenueSnapshot.find().sort({ at: 1 }).lean<any[]>().exec();
    assert.equal(snaps.length, 168);
    for (const s of snaps) {
      for (const k of ['collected', 'openBills', 'depositsDue', 'finalWaiting', 'refundsDue']) assert.ok(Number.isInteger(s[k]) && s[k] >= 0, k);
      assert.ok(s.at.getTime() <= NOW + GAP, 'not after now');
    }
    const last = snaps.at(-1)!;
    assert.equal(last.at.getTime(), hourOf(new Date(NOW + GAP)).getTime());
    assert.equal(snaps[0].at.getTime(), last.at.getTime() - 167 * HOUR);
    // The last one holds this hour's real numbers.
    const finals = await m.Bill.countDocuments({ state: 'final', 'totals.balance': { $ne: 0 } }).exec();
    assert.ok(last.openBills >= 1);
    assert.equal(last.refundsDue, 1);
    assert.ok(finals >= 1);
    assert.ok(last.collected > 0);
  });

  test('no patient name in any revenue message or alert', async () => {
    const names = (await m.Patient.find().select('name').lean<any[]>().exec()).map((p) => p.name as string).filter((n) => n && n.length >= 4);
    const clockIds = (await m.Clock.find({ def: /^revenue-/ }).select('_id').lean<any[]>().exec()).map((c) => String(c._id));
    const messages = await m.AgentMessage.find({
      $or: [{ from: 'revenue' }, { type: /^approval\./, summary: /BL-\d{4}/ }, { dedupeKey: { $in: clockIds.map((id) => `clock.expired:${id}`) } }],
    }).lean<any[]>().exec();
    assert.ok(messages.length >= 15, `${messages.length} revenue messages`);
    const alerts = await m.TaskAlertItem.find({ link: /^revenue-/ }).lean<any[]>().exec();
    assert.ok(alerts.length >= 4, `${alerts.length} revenue tasks`);
    const hay = (text: string) => text.toLowerCase();
    for (const msg of messages) {
      const text = hay(`${msg.summary} ${JSON.stringify(msg.payload ?? {})}`);
      for (const n of names) assert.ok(!text.includes(n.toLowerCase()), `${msg.type} names ${n}: ${msg.summary}`);
      assert.ok(msg.summary.length <= 140);
    }
    for (const a of alerts) {
      const text = hay(`${a.title} ${a.subtitle ?? ''}`);
      for (const n of names) assert.ok(!text.includes(n.toLowerCase()), `${a.link} names ${n}: ${a.title}`);
    }
  });

  test('reconcile sends nothing after seeding', async () => {
    // Two minutes on, so the reconcile pass's 30-second grace hides nothing the seed wrote.
    mock.timers.setTime(NOW + GAP + 2 * MIN);
    const world = await reconcileWorld();
    const snap = async () => ({
      messages: await m.AgentMessage.countDocuments().exec(),
      alerts: (await m.TaskAlertItem.find().sort({ _id: 1 }).lean<any[]>().exec()).map((a) => [String(a._id), a.link, a.status, a.title, a.subtitle]),
      bills: (await m.Bill.find().sort({ _id: 1 }).lean<any[]>().exec()).map((b) => [String(b._id), b.state, JSON.stringify(b.totals), b.announcedAt?.getTime()]),
      lines: await m.ChargeLine.countDocuments().exec(),
      payments: await m.Payment.countDocuments().exec(),
      estimates: (await m.Estimate.find().sort({ _id: 1 }).lean<any[]>().exec()).map((e) => [String(e._id), e.low, e.high, e.announcedAt?.getTime()]),
      refunds: (await m.Refund.find().sort({ _id: 1 }).lean<any[]>().exec()).map((r) => [String(r._id), r.state, r.announcedAt?.getTime()]),
      clocks: (await m.Clock.find().sort({ _id: 1 }).lean<any[]>().exec()).map((c) => [String(c._id), c.state, c.dueAt.getTime()]),
      escalations: await m.Escalation.countDocuments().exec(),
    });
    const beforeRun = await snap();
    try {
      const result = await world.reconcile.reconcile();
      assert.deepEqual(result, { announced: 0, tasks: 0, charges: 0, totals: 0, reversals: 0, clocks: 0, bedDays: 0, opdFees: 0 });
      assert.deepEqual(await snap(), beforeRun, 'nothing new was sent or written');
    } finally {
      mock.timers.setTime(NOW + GAP);
    }
  });

  test('a second run replaces the first: the same bills, no leftovers', async () => {
    const before = {
      bills: await m.Bill.countDocuments().exec(),
      lines: await m.ChargeLine.countDocuments().exec(),
      payments: await m.Payment.countDocuments().exec(),
      prices: await m.PriceItem.countDocuments().exec(),
      tasks: await m.TaskAlertItem.countDocuments({ link: /^revenue-/ }).exec(),
      messages: await m.AgentMessage.countDocuments({ from: 'revenue' }).exec(),
      clocks: await m.Clock.countDocuments({ def: /^revenue-/ }).exec(),
      approvals: await m.Approval.countDocuments({ type: /^revenue\./ }).exec(),
    };
    delete process.env.CLINIC_DATE;
    mock.timers.setTime(NOW + 2 * GAP);
    try {
      await quiet(() => seedRevenue(DAY, NOW + 2 * GAP));
    } finally {
      process.env.CLINIC_DATE = DAY;
      mock.timers.setTime(NOW + GAP);
    }
    assert.deepEqual(
      {
        bills: await m.Bill.countDocuments().exec(),
        lines: await m.ChargeLine.countDocuments().exec(),
        payments: await m.Payment.countDocuments().exec(),
        prices: await m.PriceItem.countDocuments().exec(),
        tasks: await m.TaskAlertItem.countDocuments({ link: /^revenue-/ }).exec(),
        messages: await m.AgentMessage.countDocuments({ from: 'revenue' }).exec(),
        clocks: await m.Clock.countDocuments({ def: /^revenue-/ }).exec(),
        approvals: await m.Approval.countDocuments({ type: /^revenue\./ }).exec(),
      },
      before,
    );
    assert.equal((await billOf('MHK202500327', 'admission')).number.startsWith('BL-'), true);
    assert.equal(await m.RevenueSnapshot.countDocuments().exec(), 168);
  });

  test('nothing is after now at 06:00 or 23:00', async () => {
    for (const [label, hour] of [['06:00', 6], ['23:00', 23]] as const) {
      // The next real day, so everything the earlier tests wrote is before either moment.
      const at = new Date(2026, 9, 30, hour, 0, 0).getTime();
      const clinic = new Date(2026, 8, 26, hour, 0, 5).getTime();
      mock.timers.setTime(at);
      delete process.env.CLINIC_DATE;
      try {
        await seedTheRest(at);
        await quiet(() => seedScheduling(DAY, at));
        mock.timers.setTime(at + GAP);
        await quiet(() => seedRevenue(DAY, at + GAP));
      } finally {
        process.env.CLINIC_DATE = DAY;
      }
      const now = at + GAP;
      const real = (d: Date | undefined | null, what: string) => d && assert.ok(new Date(d).getTime() <= now, `${what} ${new Date(d).toISOString()} is after now (${label})`);
      const clinicTime = (d: Date | undefined | null, what: string) => d && assert.ok(new Date(d).getTime() <= clinic, `${what} ${new Date(d).toISOString()} is after the clinic now (${label})`);

      // The story holds at either hour.
      const { patient } = await mohan();
      const mohanBill = (await m.Bill.findOne({ patient: patient._id, kind: 'er' }).lean<any>().exec())!;
      assert.equal(mohanBill.state, 'open', label);
      assert.ok(await m.Estimate.exists({ bill: mohanBill._id }), label);
      const james = await billOf('MHK202500327', 'admission');
      assert.ok(await taskOf(`revenue-bill:${james._id}:topup`), `top-up task (${label})`);
      const david = await billOf('MHK202500325', 'admission');
      assert.ok(await taskOf(`revenue-bill:${david._id}:final`), `final task (${label})`);
      assert.equal(await m.Bill.countDocuments({ state: 'settled', kind: { $in: ['er', 'admission'] } }).exec(), 3, label);
      assert.equal(await m.Bill.countDocuments({ kind: 'opd', 'totals.payments': { $gt: 0 } }).exec(), 2, label);
      assert.equal(await m.Refund.countDocuments({ state: 'approved' }).exec(), 1, label);

      for (const b of await m.Bill.find().lean<any[]>().exec()) {
        for (const k of ['createdAt', 'updatedAt', 'announcedAt']) real(b[k], `${b.number} ${k}`);
        for (const k of ['openedAt', 'finalAt', 'settledAt']) clinicTime(b[k], `${b.number} ${k}`);
      }
      for (const l of await m.ChargeLine.find().lean<any[]>().exec()) {
        real(l.createdAt, `line ${l.code} createdAt`);
        clinicTime(l.chargedAt, `line ${l.code} chargedAt`);
      }
      for (const p of await m.Payment.find().lean<any[]>().exec()) {
        real(p.createdAt, `${p.receiptNumber} createdAt`);
        clinicTime(p.at, `${p.receiptNumber} at`);
      }
      for (const e of await m.Estimate.find().lean<any[]>().exec()) {
        real(e.createdAt, 'estimate createdAt');
        clinicTime(e.at, 'estimate at');
      }
      for (const r of await m.Refund.find().lean<any[]>().exec()) {
        for (const k of ['createdAt', 'updatedAt', 'announcedAt']) real(r[k], `${r.number} ${k}`);
        clinicTime(r.paid?.at, `${r.number} paid.at`);
      }
      for (const c of await m.Correction.find().lean<any[]>().exec()) for (const k of ['createdAt', 'updatedAt']) real(c[k], `correction ${k}`);
      for (const a of await m.TaskAlertItem.find({ link: /^revenue-/ }).lean<any[]>().exec()) {
        real(a.createdAt, `${a.link} createdAt`);
        real(a.updatedAt, `${a.link} updatedAt`);
      }
      const clocks = await m.Clock.find({ def: /^revenue-/ }).lean<any[]>().exec();
      assert.ok(clocks.length >= 3, label);
      for (const c of clocks) {
        for (const k of ['startedAt', 'stoppedAt', 'createdAt', 'updatedAt']) real(c[k], `${c.def} ${k}`);
        if (c.state === 'running') assert.ok(c.dueAt.getTime() > now, `${c.def} running but due ${c.dueAt.toISOString()} (${label})`);
      }
      for (const msg of await m.AgentMessage.find({ from: 'revenue' }).lean<any[]>().exec()) real(msg.createdAt, `${msg.type} createdAt`);
      const snaps = await m.RevenueSnapshot.find().sort({ at: 1 }).lean<any[]>().exec();
      assert.equal(snaps.length, 168);
      assert.equal(snaps.at(-1)!.at.getTime(), hourOf(new Date(now)).getTime());
      for (const s of snaps) real(s.at, 'snapshot at');
    }
    mock.timers.setTime(NOW);
  });
});
