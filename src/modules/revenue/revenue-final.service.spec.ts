import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AppointmentEvents } from '../appointments/appointment-events';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { ClocksService } from '../coordinator/clocks.service';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { TimelineService } from '../timeline/timeline.service';
import { UserRole } from '../users/schemas/user.schema';
import { PriceListService } from './price-list.service';
import { RevenueBedDaysService } from './revenue-bed-days.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCaptureService } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueDepositsService } from './revenue-deposits.service';
import { RevenueEstimatesService } from './revenue-estimates.service';
import { FinalBillService } from './revenue-final.service';
import { RevenueOpdService } from './revenue-opd.service';
import { PaymentsService } from './revenue-payments.service';
import { RevenueSettingsService } from './revenue-settings.service';
import { RulesService } from '../coordinator/rules.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };
const T0 = new Date('2026-09-26T00:10:00.000Z');
const H = 60 * 60 * 1000;

describe('FinalBillService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let cases: CasesService;
  let bills: RevenueBillsService;
  let final: FinalBillService;
  let payments: PaymentsService;
  let opd: RevenueOpdService;
  let bedDays: RevenueBedDaysService;
  let patient: any;
  let caseDoc: any;
  let seq = 0;

  const stub = (key: AgentKey, types: MessageTypeDef[]) =>
    registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
  const deliver = async (from: AgentKey, type: string, payload: Record<string, unknown>) => {
    const msg = await messages.send({ case: String(caseDoc._id), from, to: ['coordinator'], type, priority: 'medium', summary: type, payload, dedupeKey: `t${++seq}` });
    assert.equal(msg!.state, 'delivered');
  };
  const erBill = async (charges = 4000, visit = new Types.ObjectId()) => {
    const b = await bills.open({ kind: 'er', patientId: String(patient._id), caseId: String(caseDoc._id), erVisitId: String(visit) });
    if (charges) await bills.adjust(String(b._id), { charges });
    return b;
  };
  const fresh = (id: unknown) => m.Bill.findById(id).lean();
  const sent = (type: string) => m.AgentMessage.find({ type }).lean();
  const running = (def: string) => m.Clock.find({ def, state: 'running' }).lean();
  const until = async (fn: () => Promise<boolean>, what = 'the effect') => {
    for (let i = 0; i < 100; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const quiet = () => new Promise((r) => setTimeout(r, 150));
  const finalTask = (id: unknown) => m.TaskAlertItem.find({ link: `revenue-bill:${String(id)}:final` }).lean();

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    messages = new MessagesService(m.AgentMessage, registry, events);
    stub('er', ER_MESSAGE_TYPES);
    stub('bed', BED_MESSAGE_TYPES);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    const settingsService = new SettingsService(m.HospitalSettings);
    const settings = new RevenueSettingsService(settingsService);
    const rules = new RulesService(registry, settingsService, events);
    cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
    const reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient);
    const prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    final = new FinalBillService(messages, reg, settings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment);
    payments = new PaymentsService(reg, settings, bills, final, m.Payment);
    opd = new RevenueOpdService(new AppointmentEvents(), prices, bills, m.Appointment, m.Patient, m.ChargeLine, final);
    const estimates = new RevenueEstimatesService(reg, settings, prices, m.Bill, m.Estimate, m.ProcedureBooking, m.Admission, m.Bed);
    const deposits = new RevenueDepositsService(messages, reg, rules, settings, prices, bills, estimates, m.Bill, m.TaskAlertItem, m.ProcedureBooking, m.Admission, m.Bed, m.Ward, m.Case);
    bedDays = new RevenueBedDaysService(messages, prices, bills, reg, m.Admission, m.Bed, m.Case, m.Bill, m.ChargeLine, estimates, deposits, final);
    bedDays.clock = () => T0;
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600991', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000091' });
    caseDoc = (await cases.openOrJoin({ patientId: String(patient._id), patientUhid: patient.uhid, patientName: patient.name, kind: 'er', priority: 'high', openedBy: 'er' })).case;
  });

  test('settle succeeds only at balance zero and is 409 when a charge landed first', async () => {
    const b = await erBill(1000);
    const id = String(b._id);
    await final.prepare(DESK, id);
    await assert.rejects(final.settle(DESK, id), (e: any) => e.status === 409 && /balance is not zero/i.test(e.message));
    assert.equal((await fresh(id))!.state, 'final');
    await payments.record(DESK, id, { amount: 1000, mode: 'cash', kind: 'settlement' });

    // A charge lands after the desk saw balance 0 but before the write: the guarded update refuses.
    const original = m.Bill.findOneAndUpdate;
    let injected = false;
    (m.Bill as any).findOneAndUpdate = function (...args: any[]) {
      if (!injected) {
        injected = true;
        const self = this;
        return {
          exec: () =>
            bills
              .addCharge(id, { code: 'x', name: 'Late dressing', category: 'consumables', qty: 1, unitPrice: 250, source: { type: 'manual', ref: 'late-1' }, by: { name: 'Desk' } })
              .then(() => (original as any).apply(self, args).exec()),
        };
      }
      return (original as any).apply(this, args);
    };
    try {
      await assert.rejects(final.settle(DESK, id), (e: any) => e.status === 409 && /balance is not zero/i.test(e.message));
    } finally {
      (m.Bill as any).findOneAndUpdate = original;
    }
    assert.equal(injected, true);
    const mid = (await fresh(id))!;
    assert.equal(mid.state, 'final');
    assert.equal(mid.totals.balance, 250);
    assert.equal((await sent('revenue.bill-settled')).length, 0);

    await payments.record(DESK, id, { amount: 250, mode: 'upi', kind: 'settlement' });
    const done = await final.settle(DESK, id);
    assert.equal(done.state, 'settled');
    assert.ok(done.settledAt);
    await assert.rejects(final.settle(DESK, id), (e: any) => e.status === 409 && /settled/i.test(e.message));
    await assert.rejects(bills.addCharge(id, { code: 'x', name: 'More', category: 'other', qty: 1, unitPrice: 5, source: { type: 'manual', ref: 'late-2' }, by: { name: 'Desk' } }), /settled/i);
  });

  test('real parallel settle and charge never leave a settled bill with a balance', async () => {
    for (let i = 0; i < 12; i++) {
      const b = await erBill(1000, new Types.ObjectId());
      const id = String(b._id);
      await payments.record(DESK, id, { amount: 1000, mode: 'cash', kind: 'settlement' });
      await final.prepare(DESK, id);
      const [s, c] = await Promise.allSettled([
        final.settle(DESK, id),
        bills.addCharge(id, { code: 'x', name: 'Racing charge', category: 'other', qty: 1, unitPrice: 100, source: { type: 'manual', ref: `race-${i}` }, by: { name: 'Desk' } }),
      ]);
      const after = (await fresh(id))!;
      const lineSum = (await m.ChargeLine.find({ bill: b._id }).lean()).reduce((n, l) => n + l.amount, 0);
      assert.equal(after.totals.charges, 1000 + lineSum, `run ${i}: totals match the 1000 base plus the lines`);
      if (after.state === 'settled') {
        assert.equal(after.totals.balance, 0, `run ${i}: a settled bill owes nothing`);
        assert.equal(s.status, 'fulfilled');
        assert.equal(c.status, 'rejected', `run ${i}: the late charge was refused`);
      } else {
        assert.equal(s.status, 'rejected');
        assert.equal(after.totals.balance, 100);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  });

  test('two payments that fill the bill at once settle it once', async () => {
    const b = await erBill(1000);
    const id = String(b._id);
    await Promise.all([payments.record(DESK, id, { amount: 600, mode: 'cash', kind: 'part' }), payments.record(DESK, id, { amount: 400, mode: 'upi', kind: 'part' })]);
    await final.prepare(DESK, id);
    const [a, c] = await Promise.allSettled([final.settle(DESK, id), final.settle(DESK, id)]);
    assert.deepEqual([a.status, c.status].sort(), ['fulfilled', 'rejected']);
    assert.equal((await sent('revenue.bill-settled')).length, 1, 'one settled message');
  });

  test('an OPD bill paid in full settles when the appointment is Completed', async () => {
    const appt = (uhid = patient.uhid) =>
      m.Appointment.create({ uhid, patientName: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000091', time: '09:30 AM', date: isoDate(clinicNow()), type: 'Consultation', condition: 'Fever', status: 'Checked In' });
    const opdBill = async (a: any, fee = 300) => {
      const b = await bills.open({ kind: 'opd', patientId: String(patient._id), appointmentId: String(a._id), day: a.date });
      await bills.adjust(String(b._id), { charges: fee });
      return b;
    };

    // Paid first, then Completed.
    const a1 = await appt();
    const b1 = await opdBill(a1);
    await payments.record(DESK, String(b1._id), { amount: 300, mode: 'cash', kind: 'settlement' });
    assert.equal((await fresh(b1._id))!.state, 'open', 'not settled while the visit goes on');
    await m.Appointment.updateOne({ _id: a1._id }, { $set: { status: 'Completed' } });
    await opd.onStatusChange({ id: String(a1._id), status: 'Completed' });
    assert.equal((await fresh(b1._id))!.state, 'settled');
    assert.equal((await sent('revenue.bill-settled')).length, 1);

    // Completed with money due: stays open, then the payment settles it (R18).
    const a2 = await appt();
    const b2 = await opdBill(a2, 500);
    await m.Appointment.updateOne({ _id: a2._id }, { $set: { status: 'Completed' } });
    await opd.onStatusChange({ id: String(a2._id), status: 'Completed' });
    assert.equal((await fresh(b2._id))!.state, 'open');
    await payments.record(DESK, String(b2._id), { amount: 500, mode: 'card', kind: 'settlement' });
    assert.equal((await fresh(b2._id))!.state, 'settled');

    // A payment before Completed never settles; a replayed Completed is harmless.
    await opd.onStatusChange({ id: String(a2._id), status: 'Completed' });
    assert.equal((await sent('revenue.bill-settled')).length, 2);
    assert.equal((await running('revenue-final')).length, 0, 'an OPD bill never gets a final-bill clock');
    assert.equal(await m.TaskAlertItem.countDocuments({ link: /:final$/ }), 0);
  });

  test('R20: an OPD bill with an unpriced line never settles by itself, on either auto path; manual settle still works', async () => {
    const appt = () =>
      m.Appointment.create({ uhid: patient.uhid, patientName: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000091', time: '09:30 AM', date: isoDate(clinicNow()), type: 'Consultation', condition: 'Fever', status: 'Completed' });
    const unpriced = (b: any, ref: string) =>
      m.ChargeLine.create({ bill: b._id, code: 'opd:consult', name: 'Consultation', category: 'consultation', qty: 1, unitPrice: 0, amount: 0, source: { type: 'opd', ref }, chargedAt: new Date(), by: { name: 'Revenue Agent' }, needsPrice: true });

    // Completed path: the only line is a needs-price consultation at 0.
    const a1 = await appt();
    const b1 = await bills.open({ kind: 'opd', patientId: String(patient._id), appointmentId: String(a1._id), day: a1.date });
    await unpriced(b1, 'u1');
    await opd.onStatusChange({ id: String(a1._id), status: 'Completed' });
    assert.equal((await fresh(b1._id))!.state, 'open', 'a bill with an unpriced line stays open');
    assert.equal((await sent('revenue.bill-settled')).length, 0);

    // Payment path (R18): an unpriced line next to a priced one, the priced one paid in full.
    const a2 = await appt();
    const b2 = await bills.open({ kind: 'opd', patientId: String(patient._id), appointmentId: String(a2._id), day: a2.date });
    await unpriced(b2, 'u2');
    await bills.adjust(String(b2._id), { charges: 300 });
    await payments.record(DESK, String(b2._id), { amount: 300, mode: 'cash', kind: 'settlement' });
    assert.equal((await fresh(b2._id))!.totals.balance, 0);
    assert.equal((await fresh(b2._id))!.state, 'open', 'a payment to 0 does not settle an unpriced bill');

    // The desk can still settle by hand.
    assert.equal((await final.settle(DESK, String(b1._id))).state, 'settled');
  });

  test('R21: an open ER or admission bill cannot settle until it is prepared; OPD and walk-in settle from open', async () => {
    const adm = await bills.open({ kind: 'admission', patientId: String(patient._id), caseId: String(caseDoc._id), admissionId: String(new Types.ObjectId()) });
    const id = String(adm._id);
    await assert.rejects(final.settle(DESK, id), (e: any) => e.status === 409 && /Prepare the final bill first/.test(e.message));
    assert.equal((await fresh(id))!.state, 'open');
    assert.equal((await sent('revenue.bill-settled')).length, 0);
    await final.prepare(DESK, id);
    assert.equal((await final.settle(DESK, id)).state, 'settled');

    const er = await erBill(0, new Types.ObjectId());
    await assert.rejects(final.settle(DESK, String(er._id)), (e: any) => e.status === 409 && /Prepare the final bill first/.test(e.message));

    const walk = await bills.open({ kind: 'walk-in', patientId: String(patient._id) });
    assert.equal((await final.settle(DESK, String(walk._id))).state, 'settled');
  });

  test('prepare lists an approved-not-issued medicine, a collected test with no charge, an active admission and a needs-price line', async () => {
    const b = await erBill(0);
    const id = String(b._id);
    const order = await m.PharmacyOrder.create({ number: 'PO-9', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseDoc._id, setting: 'ER', orderedBy: { id: 'd', name: 'Doctor' }, priority: 'routine', orderedAt: new Date() });
    await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'enoxaparin', product: 'enox40', status: 'approved' });
    await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued' });
    const req = await m.LabRequest.create({ number: 'LR-9', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseDoc._id, orderedBy: { id: 'd', name: 'Doctor' }, priority: 'routine', orderedAt: new Date(), collectBy: new Date() });
    await m.LabLine.create({ request: req._id, test: 'troponin', status: 'collected', tatDueAt: new Date() });
    await m.LabLine.create({ request: req._id, test: 'cbc', status: 'collected', tatDueAt: new Date() });
    await m.ChargeLine.create({ bill: b._id, code: 'lab:cbc', name: 'CBC', category: 'lab', qty: 1, unitPrice: 300, amount: 300, source: { type: 'lab', ref: `${req._id}:cbc` }, chargedAt: new Date(), by: { name: 'Revenue Agent' } });
    await bills.adjust(id, { charges: 300 });
    await m.ChargeLine.create({ bill: b._id, code: 'med:unlisted', name: 'Herbal tonic', category: 'pharmacy', qty: 1, unitPrice: 0, amount: 0, source: { type: 'pharmacy.issued', ref: 'x1' }, chargedAt: new Date(), by: { name: 'Revenue Agent' }, needsPrice: true });
    const adm = await m.Admission.create({ patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, bed: new Types.ObjectId(), roomClass: 'general', expectedStayDays: 3, status: 'active', admittedAt: T0, admittedBy: 'Nurse' });
    await m.Bill.updateOne({ _id: b._id }, { $set: { admission: adm._id } });

    const r = await final.prepare(DESK, id);
    assert.deepEqual(r.warnings.map((w) => w.kind).sort(), ['admission', 'lab', 'needs-price', 'pharmacy']);
    const text = r.warnings.map((w) => w.text).join(' | ');
    assert.match(text, /enox40|enoxaparin/i);
    assert.match(text, /troponin/i);
    assert.doesNotMatch(text, /cbc/i, 'the charged test is not a warning');
    assert.match(text, /Herbal tonic/);
    assert.equal(r.view.bill.state, 'final');
    assert.equal(r.view.lines.length, 2);
    const after = (await fresh(id))!;
    assert.equal(after.state, 'final');
    assert.ok(after.finalAt);

    // A clean bill has no warnings.
    const clean = await erBill(500, new Types.ObjectId());
    await m.Case.updateOne({ _id: caseDoc._id }, {});
    const lone = await bills.open({ kind: 'walk-in', patientId: String(patient._id) });
    await bills.adjust(String(lone._id), { charges: 100 });
    assert.deepEqual((await final.prepare(DESK, String(lone._id))).warnings, []);
    assert.ok(clean);
  });

  test('er.left home requests the final bill and starts the 60-minute clock; bill-final stops it', async () => {
    const visit = new Types.ObjectId();
    const b = await erBill(4000, visit);
    const id = String(b._id);
    const before = Date.now();
    await deliver('er', 'er.left', { visitId: String(visit), reason: 'home' });
    await until(async () => (await finalTask(id)).length === 1 && (await running('revenue-final')).length === 1, 'the final request');
    const [req] = await sent('revenue.final-requested');
    const due = new Date((req.payload as any).dueAt).getTime();
    assert.ok(due >= before + 60 * 60_000 - 1000 && due <= Date.now() + 60 * 60_000 + 1000, 'dueAt is real now + 60 minutes');
    assert.equal((req.payload as any).billNumber, b.number);
    const [task] = await finalTask(id);
    assert.equal(task.status, 'Pending');
    assert.equal(task.type, 'System');
    assert.ok(!/Ravi/.test(task.title), 'no name in the alert title');
    const [clock] = await running('revenue-final');
    assert.equal(String(clock.ref), id);

    // A replay sends nothing new and makes no second task.
    await deliver('er', 'er.left', { visitId: String(visit), reason: 'home' });
    await quiet();
    assert.equal((await sent('revenue.final-requested')).length, 1);
    assert.equal((await finalTask(id)).length, 1);

    const prepared = await final.prepare(DESK, id);
    assert.equal(prepared.view.bill.state, 'final');
    const [fin] = await sent('revenue.bill-final');
    assert.equal((fin.payload as any).balance, 4000);
    assert.equal((await finalTask(id))[0].status, 'Completed');
    await until(async () => (await running('revenue-final')).length === 0, 'the clock to stop');

    // Transfer, left-against-advice and died request it too; admitted does not.
    for (const reason of ['transfer', 'left-against-advice', 'died']) {
      const v = new Types.ObjectId();
      const bb = await erBill(100, v);
      await deliver('er', 'er.left', { visitId: String(v), reason });
      await until(async () => (await finalTask(bb._id)).length === 1, `final task for ${reason}`);
    }
    const v = new Types.ObjectId();
    const admitted = await erBill(100, v);
    await deliver('er', 'er.left', { visitId: String(v), reason: 'admitted' });
    await quiet();
    assert.equal((await finalTask(admitted._id)).length, 0, 'admitted: the stay goes on, no final bill yet');
  });

  test('bed.discharged requests the final bill after the last bed day, once', async () => {
    const general = await m.Ward.create({ code: 'GA', name: 'General Ward A', shortName: 'Ward A', floor: 1, type: 'general', gender: 'any', ratePerDay: 1500 });
    const bed = await m.Bed.create({ ward: general._id, label: 'GA-01', number: 1 });
    await m.PriceItem.create({ code: 'nursing:general', name: 'Nursing', category: 'nursing', price: 300, unit: 'day', active: true });
    const adm = await m.Admission.create({ patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, bed: bed._id, roomClass: 'general', expectedStayDays: 3, status: 'discharged', admittedAt: T0, dischargedAt: new Date(T0.getTime() + 30 * H), admittedBy: 'Nurse' });
    bedDays.clock = () => new Date(T0.getTime() + 31 * H);
    const payload = { bedId: String(bed._id), bedLabel: 'GA-01', admissionId: String(adm._id) };
    await deliver('bed', 'bed.discharged', payload);
    const b = (await m.Bill.findOne({ kind: 'admission', admission: adm._id }).lean())!;
    await until(async () => (await finalTask(b._id)).length === 1, 'the final request');
    assert.equal(await m.ChargeLine.countDocuments({ 'source.type': 'bed-day' }), 2, 'the last part day is charged first');
    const [req] = await sent('revenue.final-requested');
    assert.equal(String((req.payload as any).billId), String(b._id));
    await deliver('bed', 'bed.discharged', payload);
    await quiet();
    assert.equal((await sent('revenue.final-requested')).length, 1);
    assert.equal((await finalTask(b._id)).length, 1);
    assert.equal((await running('revenue-final')).length, 1);
  });

  test('settling sends bill-settled, the case close check passes and the case closes', async () => {
    const visit = new Types.ObjectId();
    const b = await erBill(2500, visit);
    const id = String(b._id);
    await deliver('er', 'er.left', { visitId: String(visit), reason: 'home' });
    await until(async () => (await finalTask(id)).length === 1, 'the final request');
    // A deposit task and a top-up task on the bill are closed by settling too.
    for (const kind of ['deposit', 'topup']) await m.TaskAlertItem.create({ title: `${kind} ${b.number}`, type: 'System', category: 'System', priority: 'Medium', status: 'Pending', link: `revenue-bill:${id}:${kind}` });
    await final.prepare(DESK, id);
    assert.equal(await cases.evaluateClose(String(caseDoc._id)), false, 'open while money is due');

    await payments.record(DESK, id, { amount: 2500, mode: 'cash', kind: 'settlement' });
    const done = await final.settle(DESK, id);
    assert.equal(done.state, 'settled');
    const [msg] = await sent('revenue.bill-settled');
    assert.deepEqual({ ...msg.payload, billId: String((msg.payload as any).billId) }, { billId: id, billNumber: b.number, total: 2500 });
    const tasks = await m.TaskAlertItem.find({ link: new RegExp(`^revenue-bill:${id}:`) }).lean();
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every((t) => t.status === 'Completed'), 'every task on the bill is completed');
    assert.equal((await running('revenue-final')).length, 0);

    assert.equal(await registry.closeChecks()[0].check(String(caseDoc._id)), 'pass');
    // The Coordinator evaluates the close check when the bill-settled message is delivered.
    await until(async () => (await m.Case.findById(caseDoc._id).lean())!.state === 'closed', 'the case to close');
    assert.equal((await m.Case.findById(caseDoc._id).lean())!.state, 'closed');
  });

  test('bill-final stops the clock before settle, and a settled bill takes no final request or prepare', async () => {
    const b = await erBill(100);
    const id = String(b._id);
    await final.request('agent', id);
    await until(async () => (await running('revenue-final')).length === 1, 'the clock');
    await payments.record(DESK, id, { amount: 100, mode: 'cash', kind: 'settlement' });
    await final.prepare(DESK, id);
    await final.settle(ADMIN, id);
    await until(async () => (await running('revenue-final')).length === 0, 'settle to stop the clock');
    await assert.rejects(final.prepare(DESK, id), /settled/i);
    assert.equal(await final.request('agent', id), false, 'nothing to request on a settled bill');
    assert.equal((await sent('revenue.final-requested')).length, 1);
  });
});
