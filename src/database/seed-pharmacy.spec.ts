import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { hourOf } from '../common/utils/series';
import { validatePayload } from '../modules/coordinator/coordinator-types';
import { PatientsService } from '../modules/patients/patients.service';
import { PharmacyPatientsService } from '../modules/pharmacy/pharmacy-patients.service';
import { DEFAULT_TARGETS } from '../modules/pharmacy/pharmacy-settings.service';
import { PHARMACY_MESSAGE_TYPES } from '../modules/pharmacy/pharmacy-coordinator.registration';
import { PharmacyPrescriptionsService } from '../modules/pharmacy/pharmacy-prescriptions.service';
import { PharmacyReconcileService } from '../modules/pharmacy/pharmacy-reconcile.service';
import { buildWorld } from '../test/pharmacy-fixtures';
import { buildStock } from '../test/pharmacy-stock-fixtures';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../test/test-db';
import { seedBeds } from './seed-beds';
import { seedCoordinator } from './seed-coordinator';
import { seedEr } from './seed-er';
import { LAB_DEMO_ACCOUNTS, seedLab } from './seed-lab';
import { PHARMACY_DEMO_RX, seedPharmacy } from './seed-pharmacy';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = '2026-09-26';
/** The latest 10:00 (local) that is at least five minutes ago and within the 72 hours a kidney result counts: the timing checks do not depend on the hour the suite runs. */
const PINNED = (() => {
  const t = new Date();
  t.setHours(10, 0, 0, 0);
  return t.getTime() <= Date.now() - 5 * MINUTE ? t.getTime() : t.getTime() - 24 * HOUR;
})();
const MIDNIGHT = new Date(PINNED).setHours(0, 0, 0, 0);
const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'seed-data', `${name}.json`), 'utf8'));

describe('seedPharmacy', () => {
  const m = models();
  let log: string[] = [];
  let seededAt = 0;
  const ids: Record<string, string> = {};

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

  // The services wired onto the seeded database, built once (it adds one patient of its own).
  let world: Awaited<ReturnType<typeof buildWorld>> | undefined;
  const getWorld = async () => {
    if (!world) {
      world = await buildWorld(m);
      // The world's own patient is not part of the demo: later reseeds see the same free patients.
      await m.Patient.deleteOne({ _id: world.patientId });
    }
    return world;
  };

  const chest = async () => {
    const visit = (await m.ErVisit.find().lean<any[]>().exec()).find((v) => /Pressure in the chest/.test(v.complaintText ?? ''))!;
    const patient = (await m.Patient.findById((await m.Case.findById(visit.case).lean<any>().exec())!.patient).lean<any>().exec())!;
    const order = (await m.PharmacyOrder.findOne({ case: visit.case }).lean<any>().exec())!;
    const lines = await m.PharmacyLine.find({ order: order._id }).sort({ _id: 1 }).lean<any[]>().exec();
    return { visit, patient, order, lines, line: (medicine: string) => lines.find((l) => l.medicine === medicine)! };
  };

  before(async () => {
    await connectTestDb();
    await resetTestDb();
    // The demo hospital as the main seed builds it: the fixture patients and prescription, and one account per role.
    await m.Patient.insertMany(fixture('patients'));
    await m.Prescription.insertMany(fixture('prescriptions'));
    for (const [key, email, name, role] of [
      ['admin', 'admin@medios.ai', 'Hospital Admin', 'admin'],
      ['doctor', 'doctor@medios.ai', 'Dr. Shajin', 'doctor'],
      ['nurse', 'nurse@medios.ai', 'Nurse Anjali Thomas', 'nurse'],
      ['pharmacist', 'pharmacy@medios.ai', 'Neethu George', 'pharmacist'],
      ['lab', 'lab@medios.ai', 'Vishnu Prasad', 'lab'],
      ['desk', 'frontdesk@medios.ai', 'Front Desk', 'staff'],
    ] as const) ids[key] = String((await m.User.create({ email, passwordHash: 'x', name, role }))._id);
    const path = LAB_DEMO_ACCOUNTS[0];
    await m.User.create({ email: path.email, passwordHash: 'x', name: path.name, role: path.role, department: path.department });
    await quiet(async () => {
      await seedBeds(DAY);
      await seedCoordinator(DAY);
      await seedEr(DAY, PINNED);
      await seedLab(DAY, PINNED);
    });
    seededAt = PINNED;
    log = await quiet(() => seedPharmacy(DAY, PINNED));
  });

  after(async () => {
    await closeTestDb();
  });

  test('seeded lines cover every status, all three settings, both stores and the OPD counter', async () => {
    const orders = await m.PharmacyOrder.find().lean<any[]>().exec();
    assert.ok(orders.length >= 23 && orders.length <= 27, `${orders.length} orders`);
    const lines = await m.PharmacyLine.find().lean<any[]>().exec();
    const statuses = new Set(lines.map((l) => l.status));
    for (const s of ['to-check', 'query', 'approved', 'issued', 'stopped', 'rejected', 'cancelled']) assert.ok(statuses.has(s), `no ${s} line`);
    assert.deepEqual([...new Set(orders.map((o) => o.setting))].sort(), ['ER', 'OPD', 'Ward']);
    assert.deepEqual([...new Set(lines.filter((l) => l.issued).map((l) => l.issued.store))].sort(), ['er', 'main']);
    // Every priority, both sources, numbering from the counter.
    assert.deepEqual([...new Set(orders.map((o) => o.priority))].sort(), ['routine', 'stat', 'urgent']);
    assert.deepEqual([...new Set(orders.map((o) => o.source))].sort(), ['order', 'prescription']);
    assert.equal(new Set(orders.map((o) => o.number)).size, orders.length);
    assert.equal((await m.CoordinatorCounter.findOne({ key: 'pharmacy-order' }).lean<any>().exec())!.last, orders.length);

    // The location records match the cases' kinds, and every ER and ward order has one.
    const locations = await m.PharmacyLocation.find().lean<any[]>().exec();
    const kind = { ER: 'er', Ward: 'ipd', OPD: 'opd' } as const;
    for (const l of locations) {
      const c = (await m.Case.findById(l.case).lean<any>().exec())!;
      // The patient waiting for a bed is still in the ER, though the bed request made the case an admission.
      if (l.area === 'ER' && c.kind === 'ipd') assert.ok(await m.ErVisit.exists({ case: c._id, status: 'waiting-bed' }).exec(), `${c.number} is an ER patient waiting for a bed`);
      else assert.equal(c.kind, kind[l.area as 'ER'], `${c.number} location`);
      assert.equal(c.state, 'open');
      assert.ok(c.agents.includes('pharmacy'), `${c.number} lists the pharmacy agent`);
      if (l.area === 'Ward') assert.ok(l.ward, 'a ward name');
    }
    for (const o of orders) {
      assert.ok(locations.some((l) => String(l.case) === String(o.case)), `${o.number} has a location`);
      assert.ok(o.announcedAt instanceof Date && o.createdAt instanceof Date, `${o.number} announcedAt`);
      if (o.setting === 'Ward') assert.ok(o.ward, `${o.number} ward`);
      const mine = lines.filter((l) => String(l.order) === String(o._id));
      assert.ok(mine.length >= 1);
      // The rounds match the lines.
      const waitingCheck = mine.filter((l) => l.status === 'to-check');
      const waitingIssue = o.setting === 'OPD' ? [] : mine.filter((l) => l.status === 'approved' && !l.waitingForStock);
      assert.equal(o.checkOpen, waitingCheck.length > 0, `${o.number} checkOpen`);
      assert.equal(o.issueOpen, waitingIssue.length > 0, `${o.number} issueOpen`);
      assert.ok(o.checkRound >= 1);
      if (waitingCheck.length) assert.equal(o.checkDueAt.getTime(), Math.min(...waitingCheck.map((l) => l.enteredCheckAt.getTime() + DEFAULT_TARGETS.check[o.priority as 'stat'] * MINUTE)));
      if (waitingIssue.length) assert.equal(o.issueDueAt.getTime(), Math.min(...waitingIssue.map((l) => l.issueFrom.getTime() + DEFAULT_TARGETS.issue[o.priority as 'stat'] * MINUTE)));
    }
    // Issued lines carry what they took, a movement and an announcement.
    for (const l of lines.filter((x) => x.issued)) {
      assert.ok(l.issued.announcedAt instanceof Date && l.issued.quantity >= 1 && l.issued.batches.length === 1, `${l._id} issued`);
      assert.equal(l.issued.batches[0].qty, l.issued.quantity);
      assert.equal(await m.PharmacyMovement.countDocuments({ line: l._id, kind: 'issued' }).exec(), 1);
      assert.equal(await m.AgentMessage.countDocuments({ type: 'pharmacy.issued', 'payload.lineId': String(l._id) }).exec(), 1);
    }
    // One rejected and one cancelled line, with their words.
    assert.equal(lines.filter((l) => l.status === 'rejected').length, 1);
    assert.equal(lines.filter((l) => l.status === 'cancelled').length, 1);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^pharmacy-rejected:/ }).exec(), 1);
    // The one answered Keep and the one stopped line.
    const kept = lines.filter((l) => l.query?.answer?.outcome === 'keep');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].status, 'issued');
    assert.equal(kept[0].query.answer.by.id, ids.doctor);
    assert.ok(kept[0].query.answer.reason.length > 1);
    assert.equal(kept[0].query.question, 'Dose may need lowering for kidney function (eGFR 26). Please review.');
    assert.deepEqual(kept[0].flags.filter((f: any) => f.kind === 'kidney').map((f: any) => [f.key, f.text, !!f.confirmed]), [['kidney.0-30', 'eGFR 26: enoxaparin, reduce to once daily', true]]);
    assert.equal(lines.filter((l) => l.status === 'stopped').length, 1);
    // Products and quantities come from the medicine list.
    for (const l of lines.filter((x) => x.product)) assert.ok(l.product.startsWith(l.medicine), `${l.product}`);
    // Every status with an open query is in the Queries list, and the answered ones from the last day too.
    const open = lines.filter((l) => l.query && !l.query.answer);
    assert.equal(open.length, 3);
    for (const l of open) {
      const alert = await m.TaskAlertItem.find({ link: `pharmacy-line:${l._id}` }).lean<any[]>().exec();
      assert.equal(alert.length, 1);
      assert.equal(alert[0].status, 'Pending');
      assert.equal(await m.Clock.countDocuments({ def: 'pharmacy-query', ref: `${l._id}:q1`, state: 'running' }).exec(), 1);
    }
    for (const l of lines.filter((x) => x.query?.answer)) {
      assert.equal((await m.TaskAlertItem.findOne({ link: `pharmacy-line:${l._id}` }).lean<any>().exec())!.status, 'Completed');
      assert.equal((await m.Clock.findOne({ def: 'pharmacy-query', ref: `${l._id}:q1` }).lean<any>().exec())!.state, 'met');
    }

    assert.match(log.join('\n'), new RegExp(`✅ ${orders.length} pharmacy orders, ${lines.length} lines, ${await m.PharmacyBatch.countDocuments().exec()} batches, 4 low, 168 snapshots`));
  });

  test('the ER chest-pain man of 62 with 64 kg has the five medicines in their states, enoxaparin carries "Kidney function not known", and his rft line is received and awaiting entry in Lab', async () => {
    const c = await chest();
    assert.deepEqual([c.patient.age, c.patient.gender, c.patient.vitals.weightKg], [62, 'Male', 64]);
    assert.equal(c.order.priority, 'stat');
    assert.equal(c.order.setting, 'ER');
    assert.equal(c.lines.length, 5);

    const aspirin = c.line('aspirin');
    assert.deepEqual([aspirin.status, aspirin.dose, aspirin.frequency, aspirin.product, aspirin.issued.store, aspirin.issued.quantity], ['issued', 300, 'STAT', 'aspirin-tab-300', 'er', 1]);
    const clopidogrel = c.line('clopidogrel');
    assert.deepEqual([clopidogrel.status, clopidogrel.dose, clopidogrel.frequency, clopidogrel.issued.store, clopidogrel.issued.quantity], ['issued', 300, 'STAT', 'er', 4]);
    const statin = c.line('atorvastatin');
    assert.deepEqual([statin.status, statin.dose, statin.frequency, statin.durationDays, statin.product], ['approved', 80, 'OD', 1, 'atorvastatin-tab-80']);
    const issueClock = (await m.Clock.findOne({ def: 'pharmacy-issue', ref: `${c.order._id}:i1` }).lean<any>().exec())!;
    assert.equal(issueClock.state, 'running');
    assert.ok(issueClock.dueAt.getTime() > seededAt, 'the issue clock is not overdue');
    assert.equal(issueClock.detail, `${c.order.number} · Aspirin`);
    const nitrate = c.line('isosorbide-dinitrate');
    assert.deepEqual([nitrate.status, nitrate.dose, nitrate.route, nitrate.product, nitrate.issued.store], ['issued', 5, 'sublingual', 'isosorbide-dinitrate-sl-tab-5', 'er']);
    const enox = c.line('enoxaparin');
    assert.deepEqual([enox.status, enox.dose, enox.frequency, enox.durationDays, enox.route], ['to-check', 60, 'BD', 5, 'sc']);
    const kidney = enox.flags.find((f: any) => f.kind === 'kidney');
    assert.deepEqual([kidney.key, kidney.severity, kidney.text], ['kidney.unknown', 'amber', 'Kidney function not known: recheck when creatinine arrives']);
    const checkClock = (await m.Clock.findOne({ def: 'pharmacy-check', ref: `${c.order._id}:c1` }).lean<any>().exec())!;
    assert.equal(checkClock.state, 'running');
    const inMin = (checkClock.dueAt.getTime() - seededAt) / MINUTE;
    assert.ok(inMin > 5.5 && inMin < 8.5, `the check clock is due in ${inMin} min`);

    // The Lab side: his Kidney function test is received and waits for a result.
    const request = (await m.LabRequest.findOne({ case: c.visit.case }).lean<any>().exec())!;
    const rft = (await m.LabLine.findOne({ request: request._id, test: 'rft' }).lean<any>().exec())!;
    assert.equal(rft.status, 'received');
    assert.ok(!rft.results.length, 'no result entered yet');
    const sample = (await m.LabSample.findOne({ lines: rft._id }).lean<any>().exec())!;
    assert.deepEqual([sample.status, sample.tube], ['received', 'serum']);
  });

  test("the Y14 ER ticagrelor line is approved with a running issue clock, and the ER store has none", async () => {
    const line = (await m.PharmacyLine.findOne({ medicine: 'ticagrelor' }).lean<any>().exec())!;
    assert.deepEqual([line.status, line.product, line.dose, line.quantity], ['approved', 'ticagrelor-tab-90', 180, 2]);
    const order = (await m.PharmacyOrder.findById(line.order).lean<any>().exec())!;
    assert.equal(order.setting, 'ER');
    assert.equal((await m.Clock.findOne({ def: 'pharmacy-issue', ref: `${order._id}:i1` }).lean<any>().exec())!.state, 'running');
    assert.equal(await m.PharmacyBatch.countDocuments({ product: 'ticagrelor-tab-90', store: 'er' }).exec(), 0);
    assert.ok((await m.PharmacyBatch.findOne({ product: 'ticagrelor-tab-90', store: 'main' }).lean<any>().exec())!.quantity > 0);
  });

  test("the penicillin ward patient's amoxicillin-clavulanate is held in an allergy query with a running clock and one Pending pharmacy-line alert", async () => {
    // The first open admission case (by number) whose patient has a Patient record.
    const wardCases = await m.Case.find({ kind: 'ipd', state: 'open', openedBy: { $ne: 'er' } }).sort({ number: 1 }).lean<any[]>().exec();
    let first: any;
    for (const c of wardCases) if (!first && (await m.Patient.exists({ _id: c.patient, address: { $ne: 'Seed: pharmacy demo' } }).exec())) first = c;
    assert.ok(first, 'an admitted patient with a record');
    const patient = (await m.Patient.findById(first.patient).lean<any>().exec())!;
    assert.ok(patient.allergies.includes('Penicillin'));

    const line = (await m.PharmacyLine.findOne({ patient: first.patient, medicine: 'amoxicillin-clavulanate' }).lean<any>().exec())!;
    assert.deepEqual([line.status, line.dose, line.frequency, line.durationDays], ['query', 625, 'TDS', 5]);
    assert.deepEqual([line.query.kind, line.query.by.name, line.query.seq, line.querySeq], ['allergy', 'Pharmacy Agent', 1, 1]);
    assert.equal(line.query.question, 'Penicillin allergy recorded: amoxicillin-clavulanate is a penicillin. Please confirm with a reason, change the dose, or cancel.');
    const flag = line.flags.find((f: any) => f.kind === 'allergy');
    assert.deepEqual([flag.key, flag.severity, !!flag.confirmed], ['allergy.amoxicillin-clavulanate', 'red', false]);
    const clock = (await m.Clock.findOne({ def: 'pharmacy-query', ref: `${line._id}:q1` }).lean<any>().exec())!;
    assert.equal(clock.state, 'running');
    const inMin = (clock.dueAt.getTime() - seededAt) / MINUTE;
    assert.ok(inMin > 17 && inMin < 22, `the query clock is due in ${inMin} min`);
    const alerts = await m.TaskAlertItem.find({ link: `pharmacy-line:${line._id}` }).lean<any[]>().exec();
    assert.equal(alerts.length, 1);
    assert.deepEqual([alerts[0].status, alerts[0].type, alerts[0].category, alerts[0].priority], ['Pending', 'Medication Alert', 'Medication', 'High']);
    assert.equal(alerts[0].title, 'Pharmacy query: Amoxicillin-clavulanate 625 mg (allergy)');
    const order = (await m.PharmacyOrder.findById(line.order).lean<any>().exec())!;
    assert.equal(order.setting, 'Ward');
    assert.ok(order.ward);
    // The agent's message and its start message carry no name.
    assert.equal(await m.AgentMessage.countDocuments({ type: 'pharmacy.query', 'payload.lineId': String(line._id) }).exec(), 1);
  });

  test('stock: 3 low pairs above 0 plus ER ticagrelor at 0; 2 batches near expiry and 1 expired; one alert per low pair', async () => {
    const w = await getWorld();
    const s = buildStock(m, w);
    process.env.CLINIC_DATE = DAY;
    try {
      const rows = await s.stock.stock();
      assert.equal(rows.length, 75 + (await m.PharmacyStockLevel.countDocuments({ store: 'er' }).exec()));
      assert.equal(rows.filter((r) => r.store === 'main').length, 75, 'Main holds every product');
      const low = rows.filter((r) => r.low);
      assert.deepEqual(low.map((r) => `${r.product}|${r.store}|${r.usable}`).sort(), [
        'amoxicillin-clavulanate-tab-625|main|30',
        'pantoprazole-tab-40|main|38',
        'salbutamol-nebule-2.5|er|12',
        'ticagrelor-tab-90|er|0',
      ]);
      // Every stocked pair has a reorder level; only the four are at or below it.
      for (const r of rows) assert.ok(r.reorderLevel > 0, `${r.product} ${r.store} has a level`);
      assert.equal(rows.filter((r) => r.nearExpiry > 0).length, 2);
      assert.equal(rows.filter((r) => r.expired > 0).length, 1);
      assert.equal((await m.PharmacyBatch.countDocuments({ expiry: { $gte: DAY, $lte: '2026-12-25' } }).exec()), 2);
      assert.equal((await m.PharmacyBatch.countDocuments({ expiry: { $lt: DAY } }).exec()), 1);

      // One alert per low pair, with its claim; the sweep finds nothing to raise.
      const levels = await m.PharmacyStockLevel.find({ lowAlertedAt: { $exists: true } }).lean<any[]>().exec();
      assert.equal(levels.length, 4);
      const alerts = await m.TaskAlertItem.find({ link: /^pharmacy-stock:/ }).lean<any[]>().exec();
      assert.equal(alerts.length, 4);
      for (const l of levels) {
        const a = alerts.filter((x) => x.link === `pharmacy-stock:${l.product}:${l.store}`);
        assert.equal(a.length, 1);
        assert.equal(a[0].lowAlertedAt.getTime(), l.lowAlertedAt.getTime());
        assert.deepEqual([a[0].status, a[0].type, a[0].category, a[0].priority], ['Pending', 'Medication Alert', 'Medication', 'Medium']);
      }
      assert.equal(alerts.find((a) => a.link === 'pharmacy-stock:ticagrelor-tab-90:er')!.title, 'Low stock: Ticagrelor tab 90 mg (ER)');
      assert.equal(await s.stock.sweepLowStock(), 0);
      assert.equal(await m.TaskAlertItem.countDocuments({ link: /^pharmacy-stock:/ }).exec(), 4);

      // The emergency set is what the ER holds, and the batches' quantities add up with their movements.
      const er = rows.filter((r) => r.store === 'er');
      for (const r of er) assert.ok(['sl-tab', 'syringe', 'vial', 'mdv', 'ampoule', 'bag', 'bottle', 'nebule'].some((f) => r.product.includes(`-${f}-`)) || ['aspirin-tab-75', 'aspirin-tab-300', 'clopidogrel-tab-75', 'ticagrelor-tab-90', 'atorvastatin-tab-40', 'atorvastatin-tab-80', 'metoprolol-tab-25', 'paracetamol-tab-500'].includes(r.product), r.product);
      for (const b of await m.PharmacyBatch.find().lean<any[]>().exec()) {
        const sum = (await m.PharmacyMovement.find({ batch: b._id }).lean<any[]>().exec()).reduce((n, x) => n + x.change, 0);
        assert.equal(sum, b.quantity, `${b.product} ${b.batchNo}`);
        assert.equal(b.takes.length, 0);
      }
    } finally {
      delete process.env.CLINIC_DATE;
    }
  });

  test('five prescription orders wait on the OPD counter', async () => {
    const orders = await m.PharmacyOrder.find({ source: 'prescription' }).lean<any[]>().exec();
    assert.equal(orders.length, 5);
    const lines = await m.PharmacyLine.find({ order: { $in: orders.map((o) => o._id) } }).lean<any[]>().exec();
    let unlisted = 0;
    let continuing = 0;
    for (const o of orders) {
      assert.equal(o.setting, 'OPD');
      assert.equal(o.priority, 'routine');
      assert.equal(o.prescriptionRev, 1);
      assert.ok(o.prescription);
      const mine = lines.filter((l) => String(l.order) === String(o._id));
      assert.ok(mine.some((l) => l.status === 'approved'), `${o.number} has an approved line`);
      for (const l of mine) {
        assert.equal(l.prescriptionRev, 1);
        assert.ok(l.prescriptionItem, 'the prescription item');
        if (!l.medicine) {
          unlisted++;
          assert.deepEqual([l.freeName, l.quantity, l.flags.map((f: any) => f.key)], ['Syp Ambroxol', null, ['list.unmatched']]);
        }
        if (l.medicine && l.durationDays === null) continuing++;
      }
      // The prescription itself is at the order's revision, and nothing is pending.
      const rx = (await m.Prescription.findById(o.prescription).lean<any>().exec())!;
      assert.equal(rx.pharmacyRev, o.prescriptionRev);
      assert.ok(rx.pharmacyRev > 0 && rx.pharmacyPending === undefined, 'Y33');
      assert.ok(rx.pharmacyBy?.name);
      // The OPD order has no issue clock.
      assert.ok(!o.issueOpen && o.issueRound === 0);
      assert.equal(await m.Clock.countDocuments({ def: 'pharmacy-issue', ref: new RegExp(`^${o._id}:`) }).exec(), 0);
    }
    assert.equal(unlisted, 1);
    assert.equal(continuing, 2);
    // The existing fixture prescription is one of them, with its five active items (the paused one is not sent).
    const fixtureRx = (await m.Prescription.findOne({ type: { $ne: PHARMACY_DEMO_RX } }).lean<any>().exec())!;
    const fx = orders.find((o) => String(o.prescription) === String(fixtureRx._id))!;
    assert.ok(fx);
    assert.equal(lines.filter((l) => String(l.order) === String(fx._id)).length, 5);
    assert.equal(await m.Prescription.countDocuments({ type: PHARMACY_DEMO_RX }).exec(), 4);
    // They show on the counter list: approved lines of an OPD order.
    const w = await getWorld();
    const counter = (await w.orders.worklist('issue')).filter((v) => v.setting === 'OPD' && v.source === 'prescription');
    assert.ok(counter.length >= 8);
    assert.equal(new Set(counter.map((v) => v.orderNumber)).size, 5);
  });

  test('the eGFR 26 and 27 patients have a released Kidney function report, and a live recheck keeps their kidney flags', async () => {
    const w = await getWorld();
    const facts = new PharmacyPatientsService(m.Patient, m.LabTestReport);
    const reports = await m.LabTestReport.find({ labLine: /^pharmacy-demo:/ }).lean<any[]>().exec();
    assert.equal(reports.length, 2);
    const seen: number[] = [];
    for (const r of reports) {
      assert.equal(r.testName, 'Kidney function');
      assert.ok(r.groups[0].parameters.some((q: any) => q.name === 'Creatinine' && typeof q.result === 'number'));
      assert.ok(Date.now() - r.updatedAt.getTime() < 72 * HOUR && r.updatedAt.getTime() <= PINNED, 'inside the 72 h window, not after now');
      const patient = (await m.Patient.findOne({ uhid: r.uhid }).lean<any>().exec())!;
      const f = await facts.facts(String(patient._id));
      seen.push(f.egfr!);
      assert.equal(f.kidneyStatus, 'known');
      // The kidney flags of that patient's lines as seeded.
      const lines = await m.PharmacyLine.find({ patient: patient._id }).lean<any[]>().exec();
      const before = lines.map((l) => [String(l._id), JSON.stringify((l.flags ?? []).filter((x: any) => x.kind === 'kidney'))]);
      assert.ok(before.some(([, k]) => k !== '[]'), 'a kidney flag is seeded');
      const results = await w.orders.recheckPatient(String(patient._id), 'order');
      assert.deepEqual(results.map((x) => String(x.line._id)), [], 'a live recheck changes nothing');
      const after = (await m.PharmacyLine.find({ patient: patient._id }).lean<any[]>().exec()).map((l) => [String(l._id), JSON.stringify((l.flags ?? []).filter((x: any) => x.kind === 'kidney'))]);
      assert.deepEqual(after, before);
    }
    assert.deepEqual(seen.sort(), [26, 27]);
  });

  test("the made-up patient keeps the sample inpatient's UHID: the same one is on its case, admission and bed request", async () => {
    const made = await m.Patient.find({ address: 'Seed: pharmacy demo' }).lean<any[]>().exec();
    assert.ok(made.length >= 1);
    for (const p of made) {
      const c = await m.Case.findOne({ patient: p._id }).lean<any>().exec();
      assert.equal(c!.patientUhid, p.uhid);
      const admission = await m.Admission.findOne({ patient: p._id }).lean<any>().exec();
      assert.ok(admission, 'the patient has an admission');
      assert.equal(admission.patientUhid, p.uhid);
      const request = await m.BedRequest.findOne({ patient: p._id }).lean<any>().exec();
      assert.ok(request, 'the patient has a bed request');
      assert.equal(request.patientUhid, p.uhid);
      assert.ok(await m.PharmacyOrder.exists({ patient: p._id, patientUhid: p.uhid }).exec());
    }
  });

  test('no patient name in any seeded pharmacy message', async () => {
    const names = (await m.Patient.find().lean<any[]>().exec()).map((p) => p.name);
    const msgs = await m.AgentMessage.find({ from: 'pharmacy' }).lean<any[]>().exec();
    assert.ok(msgs.length > 150, `${msgs.length} messages`);
    for (const msg of msgs) {
      const text = `${msg.summary} ${JSON.stringify(msg.payload)}`;
      for (const n of names) assert.ok(!text.includes(n), `"${n}" in ${msg.type}`);
      assert.ok(msg.summary.length <= 140);
      assert.match(msg.summary, /^MO-\d{4}/);
      assert.ok(!/MHK2\d{9}/.test(text), 'no UHID');
    }
    // Alert words and links, and what a clock is about, carry no name either (the alert's own patient fields are the only place a name is kept).
    for (const a of await m.TaskAlertItem.find({ link: /^pharmacy-/ }).lean<any[]>().exec()) {
      for (const n of names) assert.ok(!`${a.title} ${a.link}`.includes(n), `"${n}" in the alert ${a.link}`);
      if (a.link.startsWith('pharmacy-stock:')) assert.ok(!a.subtitle.includes('For '));
      else for (const n of names) assert.ok(!a.subtitle.includes(n), `"${n}" in the subtitle of ${a.link}`);
    }
    for (const c of await m.Clock.find({ def: /^pharmacy-/ }).lean<any[]>().exec()) for (const n of names) assert.ok(!(c.detail ?? '').includes(n), `"${n}" in a clock detail`);
  });

  test('every seeded pharmacy message carries the payload its type declares, and every pharmacy clock has a detail', async () => {
    const defs = new Map(PHARMACY_MESSAGE_TYPES.map((t) => [t.type, t]));
    for (const msg of await m.AgentMessage.find({ from: 'pharmacy' }).lean<any[]>().exec()) {
      assert.deepEqual(validatePayload(defs.get(msg.type)!, msg.payload), [], `${msg.type} ${msg.summary}`);
    }
    const clocks = await m.Clock.find({ def: /^pharmacy-/ }).lean<any[]>().exec();
    assert.ok(clocks.length > 20);
    for (const c of clocks) assert.match(c.detail ?? '', /^MO-\d{4} · /, `${c.def} detail`);
    // Every running clock is due later; every stopped one is met.
    for (const c of clocks) {
      if (c.state === 'running') assert.ok(c.dueAt.getTime() > seededAt, `${c.def} ${c.detail} overdue`);
      else {
        assert.equal(c.state, 'met');
        assert.ok(c.stoppedAt && c.metMinutes !== undefined);
      }
    }
    // Every open round has its running clock, and no closed round has one.
    for (const o of await m.PharmacyOrder.find().lean<any[]>().exec()) {
      for (const [kind, letter] of [['check', 'c'], ['issue', 'i']] as const) {
        const running = await m.Clock.countDocuments({ def: `pharmacy-${kind}`, ref: new RegExp(`^${o._id}:${letter}`), state: 'running' }).exec();
        assert.equal(running, o[`${kind}Open`] ? 1 : 0, `${o.number} ${kind} clock`);
      }
    }
    // No pharmacy escalation is open: nothing is overdue.
    assert.equal(await m.Escalation.countDocuments({ ladder: { $in: ['pharmacy', 'pharmacy-query'] } }).exec(), 0);
  });

  test('pharmacy@ is the pharmacist on duty, and a rerun replaces the pharmacy data and leaves the rest alone', async () => {
    const t = (await m.DutyTitle.findOne({ key: 'pharmacist-on-duty' }).lean<any>().exec())!;
    assert.deepEqual(t.holders.map(String), [ids.pharmacist]);
    const source = readFileSync(join(__dirname, 'seed.ts'), 'utf8');
    assert.match(source, /await seedPharmacy\(/);
    assert.ok(source.indexOf('await seedLab(') < source.indexOf('await seedPharmacy('));
    // Unrelated data survives a rerun.
    await m.Prescription.create({ uhid: 'MHK202500399', type: 'Mine', items: [] });
    const before = [await m.PharmacyOrder.countDocuments().exec(), await m.PharmacyLine.countDocuments().exec(), await m.Case.countDocuments().exec(), await m.Prescription.countDocuments({ type: PHARMACY_DEMO_RX }).exec()];
    // A case an earlier run opened for the pharmacy is cleared and opened again: no order is left pointing at a missing case.
    const used = new Set((await m.PharmacyOrder.distinct('case').exec()).map(String));
    const labOpd = (await m.Case.find({ openedBy: 'lab', kind: 'opd' }).lean<any[]>().exec()).find((c) => used.has(String(c._id)));
    assert.ok(labOpd, 'a lab-opened outpatient case holds a pharmacy order, so the rerun check is not vacuous');
    await m.Case.updateOne({ _id: labOpd!._id }, { $set: { openedBy: 'pharmacy' } });
    await quiet(() => seedPharmacy(DAY, PINNED));
    for (const o of await m.PharmacyOrder.find().lean<any[]>().exec()) {
      assert.ok(await m.Case.exists({ _id: o.case }).exec(), `${o.number} has its case`);
      assert.ok(await m.PharmacyLocation.exists({ case: o.case }).exec(), `${o.number} has its location`);
    }
    for (const l of await m.PharmacyLocation.find().lean<any[]>().exec()) assert.ok(await m.Case.exists({ _id: l.case }).exec());
    assert.deepEqual([await m.PharmacyOrder.countDocuments().exec(), await m.PharmacyLine.countDocuments().exec(), await m.Case.countDocuments().exec(), await m.Prescription.countDocuments({ type: PHARMACY_DEMO_RX }).exec()], before);
    assert.equal(await m.Prescription.countDocuments({ type: 'Mine' }).exec(), 1);
    assert.equal(await m.PharmacyOrder.countDocuments().exec(), (await m.PharmacyOrder.distinct('number').exec()).length);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^pharmacy-line:/ }).exec(), await m.PharmacyLine.countDocuments({ query: { $exists: true } }).exec());
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^pharmacy-stock:/ }).exec(), 4);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /^pharmacy-rejected:/ }).exec(), 1);
    await m.Prescription.deleteMany({ type: 'Mine' });
  });

  test('reconcile finds nothing to send after seeding', async () => {
    const w = await getWorld();
    const s = buildStock(m, w);
    const rxSvc = new PharmacyPrescriptionsService(m.Prescription, m.PharmacyOrder, m.PharmacyLine, w.orders, w.checks, new PatientsService(m.Patient));
    const rec = new PharmacyReconcileService(m.PharmacyOrder, m.PharmacyLine, m.Clock, m.AgentMessage, w.orders, w.checks, s.issue, s.stock, m.Prescription, rxSvc);
    const logged: string[] = [];
    (rec as any).logger = { error: (x: string) => logged.push(x), log: () => undefined, warn: () => undefined };
    const sent: unknown[] = [];
    const realSend = w.messages.send.bind(w.messages);
    w.messages.send = async (x: unknown) => {
      sent.push(x);
      return null;
    };
    const snap = async () => ({
      orders: await m.PharmacyOrder.find().sort({ _id: 1 }).lean().exec(),
      lines: await m.PharmacyLine.find().sort({ _id: 1 }).lean().exec(),
      clocks: await m.Clock.find().sort({ _id: 1 }).lean().exec(),
      alerts: await m.TaskAlertItem.find().sort({ _id: 1 }).lean().exec(),
      batches: await m.PharmacyBatch.find().sort({ _id: 1 }).lean().exec(),
      movements: await m.PharmacyMovement.countDocuments().exec(),
      prescriptions: await m.Prescription.find().sort({ _id: 1 }).lean().exec(),
      messages: await m.AgentMessage.countDocuments().exec(),
    });
    const before = await snap();
    // Nothing is "in flight": every row and message is older than the reconcile pass's grace periods.
    for (const d of [...before.orders, ...before.lines] as any[]) assert.ok(Date.now() - d.updatedAt.getTime() > 45_000, 'a row touched in the last 45 s would be skipped');
    for (const msg of await m.AgentMessage.find({ from: 'pharmacy' }).lean<any[]>().exec()) assert.ok(Date.now() - msg.createdAt.getTime() > 45_000, 'a message sent in the last 45 s would block a resend');
    let result;
    try {
      result = await rec.reconcile();
    } finally {
      w.messages.send = realSend;
    }
    assert.deepEqual(result, { ordered: 0, rounds: 0, done: 0, queries: 0, answers: 0, issued: 0, takes: 0, replacements: 0, holds: 0, released: 0, prescriptions: 0 });
    assert.deepEqual(logged, []);
    assert.equal(sent.length, 0);
    assert.deepEqual(await snap(), before, 'nothing changed');
    // The fixture prescription is at its order's revision with nothing pending.
    const fixtureRx = (await m.Prescription.findOne({ type: { $ne: PHARMACY_DEMO_RX }, items: { $ne: [] } }).lean<any>().exec())!;
    const order = (await m.PharmacyOrder.findOne({ prescription: fixtureRx._id }).lean<any>().exec())!;
    assert.deepEqual([fixtureRx.pharmacyRev, order.prescriptionRev, fixtureRx.pharmacyPending], [1, 1, undefined]);
    assert.equal(await m.Prescription.countDocuments({ pharmacyPending: true }).exec(), 0);
  });

  test('writing his Kidney function report with creatinine 2.5 and delivering lab.resulted for rft opens a kidney query on enoxaparin with eGFR 28', async () => {
    const w = await getWorld();
    const c = await chest();
    const enox = c.line('enoxaparin');
    await m.LabTestReport.create({
      uhid: c.patient.uhid,
      testName: 'Kidney function',
      category: 'Biochemistry',
      groups: [{ category: 'Kidney function', parameters: [{ name: 'Creatinine', result: 2.5, referenceRange: '0.7-1.3', unit: 'mg/dL', status: 'High' }] }],
      labLine: 'k1',
    });
    const msg = await w.labResulted(String(c.visit.case), 'rft');
    assert.ok(msg);
    const line = (await m.PharmacyLine.findById(enox._id).lean<any>().exec())!;
    assert.deepEqual(line.flags.filter((f: any) => f.kind === 'kidney').map((f: any) => [f.key, f.severity, f.text]), [['kidney.0-30', 'red', 'eGFR 28: enoxaparin, reduce to once daily']]);
    assert.deepEqual([line.status, line.query.kind, line.query.by.name, line.query.question], ['query', 'kidney', 'Pharmacy Agent', 'Dose may need lowering for kidney function (eGFR 28). Please review.']);
    assert.equal(await m.TaskAlertItem.countDocuments({ link: `pharmacy-line:${enox._id}`, status: 'Pending' }).exec(), 1);
    // The other four medicines are untouched.
    for (const l of c.lines.filter((x) => String(x._id) !== String(enox._id))) assert.equal((await m.PharmacyLine.findById(l._id).lean<any>().exec())!.querySeq, 0);
    // Put the demo back as the seed leaves it.
    await m.LabTestReport.deleteMany({ labLine: 'k1' });
    await quiet(() => seedPharmacy(DAY, PINNED));
    assert.equal((await m.PharmacyLine.findById(enox._id).lean<any>().exec())?.querySeq ?? 0, 0, 'ids change on a rerun; the new enoxaparin line has no query');
  });

  test('168 snapshots, ending this hour', async () => {
    const snaps = await m.PharmacySnapshot.find().sort({ hour: 1 }).lean<any[]>().exec();
    assert.equal(snaps.length, 168);
    for (const s of snaps) for (const k of ['ordersToday', 'toCheck', 'openQueries', 'issuedToday', 'lowStock']) assert.ok(Number.isInteger(s[k]) && s[k] >= 0, `${k}`);
    const last = snaps.at(-1)!;
    assert.equal(last.hour.getTime(), hourOf(new Date(last.at)).getTime());
    assert.equal(last.lowStock, 4);
    assert.equal(last.openQueries, 3);
    assert.equal(last.ordersToday, (await m.PharmacyOrder.find({ createdAt: { $gte: new Date(MIDNIGHT) } }).lean().exec()).length);
    assert.equal(snaps[0].hour.getTime(), last.hour.getTime() - 167 * HOUR);
  });

  test('nothing seeded is after now at 06:00 or 23:00', async () => {
    for (const [label, hour] of [['06:00', 6], ['23:00', 23]] as const) {
      const day = new Date(2026, 9, 29, hour, 0, 0).getTime();
      const clinic = new Date(2026, 8, 26, hour, 0, 0).getTime();
      // The ER visits and the lab requests are placed against the same moment, so the orders can sit on them.
      await quiet(async () => {
        await seedEr(DAY, day);
        await seedLab(DAY, day);
        await seedPharmacy(DAY, day);
      });
      const real = (d: Date | undefined | null, what: string) => d && assert.ok(d.getTime() <= day, `${what} ${d.toISOString()} is after now (${label})`);
      const clinicTime = (d: Date | undefined | null, what: string) => d && assert.ok(d.getTime() <= clinic, `${what} ${d.toISOString()} is after the clinic now (${label})`);

      const orders = await m.PharmacyOrder.find().lean<any[]>().exec();
      assert.ok(orders.length >= 23);
      for (const o of orders) {
        for (const k of ['createdAt', 'updatedAt', 'announcedAt', 'checkDueAt', 'issueDueAt']) if (k.endsWith('DueAt')) assert.ok(!o[k] || o[k].getTime() >= o.createdAt.getTime()); else real(o[k], `${o.number} ${k}`);
        clinicTime(o.orderedAt, `${o.number} orderedAt`);
        if (o.checkOpen) assert.ok(o.checkDueAt.getTime() > day, `${o.number} check due ${o.checkDueAt.toISOString()}`);
        if (o.issueOpen) assert.ok(o.issueDueAt.getTime() > day, `${o.number} issue due ${o.issueDueAt.toISOString()}`);
      }
      for (const l of await m.PharmacyLine.find().lean<any[]>().exec()) {
        for (const k of ['createdAt', 'updatedAt', 'enteredCheckAt', 'checkedAt', 'issueFrom']) real(l[k], `line ${k}`);
        real(l.issued?.realAt, 'issued.realAt');
        real(l.issued?.announcedAt, 'issued.announcedAt');
        real(l.query?.openedRealAt, 'query.openedRealAt');
        real(l.query?.answer?.realAt, 'answer.realAt');
        for (const x of [l.approved?.at, l.rejected?.at, l.issued?.at, l.cancelled?.at, l.stopped?.at, l.query?.at, l.query?.answer?.at]) clinicTime(x, 'line clinic time');
        if (l.query && !l.query.answer) assert.ok(l.query.dueAt.getTime() > day, 'a running query is not overdue');
      }
      for (const c of await m.Clock.find({ def: /^pharmacy-/ }).lean<any[]>().exec()) {
        for (const k of ['startedAt', 'stoppedAt', 'createdAt', 'updatedAt']) real(c[k], `${c.def} ${k}`);
        if (c.state === 'running') assert.ok(c.dueAt.getTime() > day, `${c.def} running but due ${c.dueAt.toISOString()}`);
      }
      const pharmacyCases = await m.Case.find({ openedBy: 'pharmacy' }).lean<any[]>().exec();
      for (const c of pharmacyCases) {
        clinicTime(c.openedAt, `${c.number} openedAt`);
        real(c.createdAt, `${c.number} createdAt`);
        real(c.updatedAt, `${c.number} updatedAt`);
      }
      for (const msg of await m.AgentMessage.find({ $or: [{ from: 'pharmacy' }, { case: { $in: pharmacyCases.map((c) => c._id) } }] }).lean<any[]>().exec()) real(msg.createdAt, `${msg.type} createdAt`);
      for (const a of await m.TaskAlertItem.find({ link: /^pharmacy-/ }).lean<any[]>().exec()) {
        real(a.createdAt, `${a.link} createdAt`);
        real(a.updatedAt, `${a.link} updatedAt`);
        real(a.lowAlertedAt, 'lowAlertedAt');
      }
      for (const b of await m.PharmacyBatch.find().lean<any[]>().exec()) {
        real(b.receivedAt, 'batch receivedAt');
        clinicTime(b.receivedAt, 'batch receivedAt');
      }
      for (const mv of await m.PharmacyMovement.find().lean<any[]>().exec()) {
        real(mv.createdAt, 'movement createdAt');
        clinicTime(mv.at, 'movement at');
      }
      for (const p of await m.Prescription.find({ type: PHARMACY_DEMO_RX }).lean<any[]>().exec()) real(p.createdAt, 'prescription createdAt');
      for (const l of await m.PharmacyStockLevel.find({ lowAlertedAt: { $exists: true } }).lean<any[]>().exec()) real(l.lowAlertedAt, 'level lowAlertedAt');
      const snaps = await m.PharmacySnapshot.find().sort({ hour: 1 }).lean<any[]>().exec();
      assert.equal(snaps.length, 168);
      assert.equal(snaps.at(-1)!.hour.getTime(), hourOf(new Date(day)).getTime());
      assert.equal(snaps[0].hour.getTime(), hourOf(new Date(day)).getTime() - 167 * HOUR);
      for (const s of snaps) real(s.at, 'snapshot at');
    }
  });
});
