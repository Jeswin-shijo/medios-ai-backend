import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { BED_MESSAGE_TYPES } from '../beds/bed-coordinator.bridge';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { LAB_MESSAGE_TYPES } from '../lab/lab-coordinator.registration';
import { PHARMACY_MESSAGE_TYPES } from '../pharmacy/pharmacy-coordinator.registration';
import { SCHEDULING_MESSAGE_TYPES } from '../scheduling/scheduling-coordinator.registration';
import { PriceListService } from './price-list.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCaptureService, SuggestedReversal } from './revenue-capture.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';

const BY = { id: 'u1', name: 'Dr Test' };

describe('RevenueCaptureService', () => {
  const m = models();
  let registry: AgentRegistry;
  let messages: MessagesService;
  let reg: RevenueCoordinatorRegistration;
  let bills: RevenueBillsService;
  let capture: RevenueCaptureService;
  let prices: PriceListService;
  let patient: any;
  let caseId: Types.ObjectId;

  const stub = (key: AgentKey, types: MessageTypeDef[]) =>
    registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });

  /** Sends the message; the Coordinator's store delivers it to Revenue's handler. A fresh dedupe key makes each call a redelivery past the 60 s window. */
  let seq = 0;
  const deliver = async (from: AgentKey, type: string, payload: Record<string, unknown>, withCase: Types.ObjectId | null = caseId) => {
    const msg = await messages.send({ case: withCase ? String(withCase) : null, from, to: ['coordinator'], type, priority: 'medium', summary: type, payload, dedupeKey: `t${++seq}` });
    assert.equal(msg!.state, 'delivered', 'the handler ran without failing');
  };
  const issued = (lineId: string, quantity: number) => ({
    orderId: 'o', orderNumber: 'PO-1', lineId, medicine: 'x', priority: 'routine', setting: 'ER', version: 1, checkRound: 1, checkDueAt: new Date(), issueRound: 1, issueDueAt: new Date(), store: 'er', quantity,
  });
  const price = (code: string, p: number, name = code) => m.PriceItem.create({ code, name, category: code.startsWith('lab') ? 'lab' : 'other', price: p, unit: 'each', active: true });
  const lines = () => m.ChargeLine.find({}).sort({ _id: 1 }).lean();

  const visit = (extra: Record<string, unknown> = {}) =>
    m.ErVisit.create({ number: `ER-${Math.random().toString().slice(2, 6)}`, patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, mode: 'walk-in', complaint: 'chest-pain', arrivedAt: new Date(), case: caseId, ...extra });
  const labRequest = async (tests: { test: string; status?: string }[]) => {
    const r = await m.LabRequest.create({ number: `LR-${Math.random().toString().slice(2, 6)}`, patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, orderedBy: BY, priority: 'routine', orderedAt: new Date(), collectBy: new Date() });
    for (const t of tests) await m.LabLine.create({ request: r._id, test: t.test, status: t.status ?? 'ordered', tatDueAt: new Date() });
    return r;
  };

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    registry = new AgentRegistry();
    messages = new MessagesService(m.AgentMessage, registry, new CoordinatorEvents());
    stub('er', ER_MESSAGE_TYPES);
    stub('lab', LAB_MESSAGE_TYPES);
    stub('pharmacy', PHARMACY_MESSAGE_TYPES);
    stub('scheduling', SCHEDULING_MESSAGE_TYPES);
    stub('bed', BED_MESSAGE_TYPES);
    reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient, undefined, m.Admission);
    prices = new PriceListService(m.PriceItem, m.Ward, m.OpDoctor);
    capture = new RevenueCaptureService(messages, prices, bills, reg, m.ErVisit, m.LabRequest, m.LabLine, m.PharmacyLine, m.PharmacyOrder, m.ProcedureBooking, m.ConsultRequest, m.ChargeLine);
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600951', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000051' });
    caseId = new Types.ObjectId();
  });

  test('an ER arrival opens an ER bill with the registration fee; doctor-seen adds the ER doctor fee once', async () => {
    await price('er:registration', 200, 'ER registration');
    await price('er:doctor', 500, 'ER doctor');
    const v = await visit();
    await deliver('er', 'er.arrived', { visitId: String(v._id), visitNumber: v.number, complaint: 'chest-pain' });
    await deliver('er', 'er.arrived', { visitId: String(v._id), visitNumber: v.number, complaint: 'chest-pain' });
    const bill = await m.Bill.findOne({}).lean();
    assert.equal(bill!.kind, 'er');
    assert.equal(String(bill!.erVisit), String(v._id));
    assert.equal(bill!.totals.charges, 200);
    await deliver('er', 'er.doctor-seen', { visitId: String(v._id) });
    await deliver('er', 'er.doctor-seen', { visitId: String(v._id) });
    const ls = await lines();
    assert.deepEqual(ls.map((l) => [l.code, l.amount, l.category, l.by.name]), [['er:registration', 200, 'er', 'Revenue Agent'], ['er:doctor', 500, 'er', 'Revenue Agent']]);
    assert.equal((await m.Bill.countDocuments({})), 1);
    assert.equal((await m.Bill.findOne({}).lean())!.totals.charges, 700);
  });

  test('lab.collected charges each non-cancelled test once; a recollected sample\'s lab.collected adds nothing', async () => {
    await price('lab:cbc', 300);
    await price('lab:crp', 400);
    await price('lab:lft', 600);
    const r = await labRequest([{ test: 'cbc' }, { test: 'crp' }, { test: 'lft', status: 'cancelled' }]);
    const payload = { requestId: String(r._id), sampleId: 's1', sampleNumber: 'S-1', tube: 'edta', tests: ['cbc', 'crp', 'lft'] };
    await deliver('lab', 'lab.collected', payload);
    assert.deepEqual((await lines()).map((l) => [l.code, l.amount, l.source.ref]), [['lab:cbc', 300, `${r._id}:cbc`], ['lab:crp', 400, `${r._id}:crp`]]);
    await deliver('lab', 'lab.collected', { ...payload, sampleId: 's2', sampleNumber: 'S-2' });
    assert.equal((await lines()).length, 2);
    assert.equal((await m.Bill.findOne({}).lean())!.totals.charges, 700);
  });

  test('a lab test cancelled after charging creates one pending suggested reversal', async () => {
    await price('lab:cbc', 300);
    const r = await labRequest([{ test: 'cbc' }, { test: 'crp' }]);
    const events: SuggestedReversal[] = [];
    capture.onSuggestedReversal.push((e) => void events.push(e));
    capture.onSuggestedReversal.push(() => {
      throw new Error('a bad listener');
    });
    await deliver('lab', 'lab.collected', { requestId: String(r._id), sampleId: 's1', sampleNumber: 'S-1', tube: 'edta', tests: ['cbc'] });
    const cancelled = (test: string) => ({ requestId: String(r._id), lineId: 'x', test, tatDueAt: new Date(), escalateAt: new Date() });
    await deliver('lab', 'lab.cancelled', cancelled('crp')); // never charged: nothing
    assert.equal(events.length, 0);
    await deliver('lab', 'lab.cancelled', cancelled('cbc'));
    const charged = (await lines())[0];
    assert.deepEqual(events, [{ billId: String(charged.bill), lineId: String(charged._id), reason: 'Lab test cbc was cancelled after it was charged' }]);
    assert.equal((await lines()).length, 1, 'no correction is created here');
  });

  test('pharmacy.issued charges product x quantity; an unlisted medicine is 0 needs price', async () => {
    await price('med:para500', 4, 'Paracetamol 500 mg');
    const order = await m.PharmacyOrder.create({ number: 'PO-1', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, setting: 'ER', orderedBy: BY, priority: 'routine', orderedAt: new Date() });
    const listed = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued' });
    const unlisted = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: null, product: null, freeName: 'Herbal tonic', status: 'issued' });
    await deliver('pharmacy', 'pharmacy.issued', issued(String(listed._id), 10));
    await deliver('pharmacy', 'pharmacy.issued', issued(String(listed._id), 10));
    await deliver('pharmacy', 'pharmacy.issued', issued(String(unlisted._id), 2));
    const ls = await lines();
    assert.deepEqual(ls.map((l) => [l.code, l.name, l.qty, l.unitPrice, l.amount, l.needsPrice, l.category]), [
      ['med:para500', 'Paracetamol 500 mg', 10, 4, 40, false, 'pharmacy'],
      ['med:unlisted', 'Herbal tonic', 2, 0, 0, true, 'pharmacy'],
    ]);
    assert.deepEqual(ls.map((l) => l.source), [{ type: 'pharmacy.issued', ref: String(listed._id) }, { type: 'pharmacy.issued', ref: String(unlisted._id) }]);
  });

  test('a missing price still charges 0 with needs price', async () => {
    const r = await labRequest([{ test: 'tsh' }]);
    await deliver('lab', 'lab.collected', { requestId: String(r._id), sampleId: 's1', sampleNumber: 'S-1', tube: 'x', tests: ['tsh'] });
    const l = (await lines())[0];
    assert.deepEqual([l.code, l.unitPrice, l.needsPrice], ['lab:tsh', 0, true]);
  });

  test('procedure-done charges the package; consult-seen the consult fee', async () => {
    await price('proc:angiography', 25000, 'Coronary angiography');
    await price('consult:urgent', 800, 'Urgent consult');
    const b = await m.ProcedureBooking.create({ number: 'PB-1', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, procedure: 'angiography', priority: 'urgent', requestedBy: BY, earliest: new Date() } as any);
    const c = await m.ConsultRequest.create({ number: 'CN-1', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, departmentCode: 'cardio', priority: 'urgent', dueAt: new Date(), requestedBy: BY, requestedAt: new Date() } as any);
    await deliver('scheduling', 'scheduling.procedure-done', { bookingId: String(b._id), number: 'PB-1', procedure: 'angiography', priority: 'urgent', status: 'done' });
    await deliver('scheduling', 'scheduling.procedure-done', { bookingId: String(b._id), number: 'PB-1', procedure: 'angiography', priority: 'urgent', status: 'done' });
    await deliver('scheduling', 'scheduling.consult-seen', { consultId: String(c._id), number: 'CN-1', department: 'Cardiology', priority: 'urgent', dueAt: new Date() });
    const ls = await lines();
    assert.deepEqual(ls.map((l) => [l.code, l.amount, l.category, l.source]), [
      ['proc:angiography', 25000, 'procedure', { type: 'procedure', ref: String(b._id) }],
      ['consult:urgent', 800, 'consultation', { type: 'consult', ref: String(c._id) }],
    ]);
  });

  test('every charge for a patient with an open ER case lands on the ER bill', async () => {
    await price('er:registration', 200);
    await price('lab:cbc', 300);
    const v = await visit();
    await deliver('er', 'er.arrived', { visitId: String(v._id), visitNumber: v.number, complaint: 'chest-pain' });
    const r = await labRequest([{ test: 'cbc' }]);
    await deliver('lab', 'lab.collected', { requestId: String(r._id), sampleId: 's1', sampleNumber: 'S-1', tube: 'x', tests: ['cbc'] });
    assert.equal(await m.Bill.countDocuments({}), 1);
    const bill = await m.Bill.findOne({}).lean();
    assert.equal(bill!.kind, 'er');
    assert.equal(bill!.totals.charges, 500);
    assert.deepEqual((await lines()).map((l) => String(l.bill)), [String(bill!._id), String(bill!._id)]);
  });

  test('handlers never throw: missing message, missing record, bad id, settled bill', async () => {
    const handler = (t: string) => registry.definitions().find((d) => d.key === 'revenue')!.handles!.find((h) => h.type === t)!.handler;
    await handler('er.arrived')(String(new Types.ObjectId()));
    await handler('er.arrived')('not-an-id');
    await deliver('er', 'er.arrived', { visitId: String(new Types.ObjectId()), visitNumber: 'x', complaint: 'x' });
    await deliver('pharmacy', 'pharmacy.issued', issued(String(new Types.ObjectId()), 1));
    await deliver('scheduling', 'scheduling.consult-seen', { consultId: 'junk', number: 'x', department: 'x', priority: 'routine', dueAt: new Date() });
    // A late charge after settlement goes on a fresh bill (open() ignores settled ones), so nothing throws.
    const v = await visit();
    await deliver('er', 'er.arrived', { visitId: String(v._id), visitNumber: v.number, complaint: 'x' });
    await m.Bill.updateOne({}, { state: 'settled' });
    await deliver('er', 'er.doctor-seen', { visitId: String(v._id) });
    assert.equal((await lines()).length, 2);
    assert.equal(await m.Bill.countDocuments({}), 2);
  });

  test('a charge that hits a settled bill (409) is logged, not thrown', async () => {
    const v = await visit();
    const bill = await bills.open({ kind: 'er', erVisitId: String(v._id), caseId: String(caseId), patientId: String(patient._id) });
    const orig = bills.open.bind(bills);
    bills.open = async (i) => {
      await orig(i);
      await m.Bill.updateOne({ _id: bill._id }, { state: 'settled' });
      return bill;
    };
    await deliver('er', 'er.arrived', { visitId: String(v._id), visitNumber: v.number, complaint: 'x' });
    assert.equal(await m.ChargeLine.countDocuments({}), 0);
  });

  test('a replay after the bill is settled opens no new bill', async () => {
    await price('er:registration', 200);
    await price('er:doctor', 500);
    await price('lab:cbc', 300);
    await price('proc:angiography', 25000);
    await price('consult:urgent', 800);
    const v = await visit();
    const r = await labRequest([{ test: 'cbc' }]);
    const b = await m.ProcedureBooking.create({ number: 'PB-2', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, procedure: 'angiography', priority: 'urgent', requestedBy: BY, earliest: new Date() } as any);
    const c = await m.ConsultRequest.create({ number: 'CN-2', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, departmentCode: 'cardio', priority: 'urgent', dueAt: new Date(), requestedBy: BY, requestedAt: new Date() } as any);
    const order = await m.PharmacyOrder.create({ number: 'PO-2', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, setting: 'ER', orderedBy: BY, priority: 'routine', orderedAt: new Date() });
    await price('med:para500', 4);
    const pl = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued' });
    const send = async () => {
      await deliver('er', 'er.arrived', { visitId: String(v._id), visitNumber: v.number, complaint: 'x' });
      await deliver('er', 'er.doctor-seen', { visitId: String(v._id) });
      await deliver('lab', 'lab.collected', { requestId: String(r._id), sampleId: 's1', sampleNumber: 'S-1', tube: 'x', tests: ['cbc'] });
      await deliver('pharmacy', 'pharmacy.issued', issued(String(pl._id), 1));
      await deliver('scheduling', 'scheduling.procedure-done', { bookingId: String(b._id), number: 'PB-2', procedure: 'angiography', priority: 'urgent', status: 'done' });
      await deliver('scheduling', 'scheduling.consult-seen', { consultId: String(c._id), number: 'CN-2', department: 'Cardiology', priority: 'urgent', dueAt: new Date() });
    };
    await send();
    const before = await m.ChargeLine.countDocuments({});
    await m.Bill.updateMany({}, { state: 'settled' });
    const bills0 = await m.Bill.countDocuments({});
    await send();
    assert.equal(await m.Bill.countDocuments({}), bills0);
    assert.equal(await m.Bill.countDocuments({ state: 'open' }), 0);
    assert.equal(await m.ChargeLine.countDocuments({}), before);
  });

  /** A stay whose admission bill on the case was settled while the patient is still in the bed (or, with `status`, has left). */
  const settledStay = async (status = 'active') => {
    const adm = await m.Admission.create({
      patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, bed: new Types.ObjectId(), roomClass: 'general', expectedStayDays: 3,
      status, admittedAt: new Date(Date.now() - 3 * 86_400_000), admittedBy: 'Nurse',
    });
    const settled = await m.Bill.create({
      number: 'BL-0900', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, kind: 'admission', state: 'settled', case: caseId,
      admission: adm._id, openedAt: new Date(Date.now() - 3 * 86_400_000), finalAt: new Date(), settledAt: new Date(), payer: 'self',
      totals: { charges: 9000, discounts: 0, payments: 9000, refunds: 0, balance: 0 },
    });
    return { adm, settled };
  };
  const cbcCollected = async () => {
    const r = await labRequest([{ test: 'cbc' }]);
    await deliver('lab', 'lab.collected', { requestId: String(r._id), sampleId: `s-${r._id}`, sampleNumber: 'S-1', tube: 'edta', tests: ['cbc'] });
  };
  const settle = (id: unknown, paid: number) => m.Bill.updateOne({ _id: id }, { $set: { state: 'settled', finalAt: new Date(), settledAt: new Date(), 'totals.payments': paid, 'totals.balance': 0 } });

  test('a lab charge after settlement goes on a continuation bill, not walk-in', async () => {
    await price('lab:cbc', 300);
    const { adm, settled } = await settledStay();
    const untouched = await m.Bill.findById(settled._id).lean();
    await cbcCollected();
    assert.equal(await m.Bill.countDocuments({ kind: { $in: ['walk-in', 'opd'] } }), 0, 'no walk-in or OPD bill');
    const next = (await m.Bill.findOne({ _id: { $ne: settled._id } }).lean()) as any;
    assert.ok(next, 'a continuation bill');
    assert.deepEqual(
      [next.kind, next.state, String(next.admission), String(next.case), String(next.continuationOf), String(next.patient), next.patientUhid],
      ['admission', 'open', String(adm._id), String(caseId), String(settled._id), String(patient._id), patient.uhid],
    );
    assert.notEqual(next.number, settled.number);
    assert.deepEqual([next.totals.charges, next.totals.balance], [300, 300]);
    assert.deepEqual((await lines()).map((l) => [String(l.bill), l.code]), [[String(next._id), 'lab:cbc']]);
    assert.deepEqual(await m.Bill.findById(settled._id).lean(), untouched, 'the settled bill is untouched');
  });

  test('a second late charge joins the same continuation bill', async () => {
    await price('lab:cbc', 300);
    await price('med:para500', 4);
    await price('consult:urgent', 800);
    await price('proc:angiography', 25000);
    const { adm, settled } = await settledStay();
    await cbcCollected();
    const order = await m.PharmacyOrder.create({ number: 'PO-3', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, setting: 'Ward', orderedBy: BY, priority: 'routine', orderedAt: new Date() });
    const pl = await m.PharmacyLine.create({ order: order._id, patient: patient._id, medicine: 'paracetamol', product: 'para500', status: 'issued' });
    await deliver('pharmacy', 'pharmacy.issued', issued(String(pl._id), 10));
    const stay = await m.Bill.find({ kind: 'admission', admission: adm._id }).sort({ _id: 1 }).lean();
    assert.equal(stay.length, 2, 'one continuation bill for both charges');
    assert.equal(await m.Bill.countDocuments({}), 2);
    assert.deepEqual([stay[1].state, stay[1].totals.charges, stay[1].totals.balance], ['open', 340, 340]);
    assert.deepEqual([settled.totals.charges, (await m.Bill.findById(settled._id).lean())!.totals.charges], [9000, 9000]);

    // Once that one is settled too, the next late charge opens another, which continues it.
    await settle(stay[1]._id, 340);
    const c = await m.ConsultRequest.create({ number: 'CN-3', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, departmentCode: 'cardio', priority: 'urgent', dueAt: new Date(), requestedBy: BY, requestedAt: new Date() } as any);
    await deliver('scheduling', 'scheduling.consult-seen', { consultId: String(c._id), number: 'CN-3', department: 'Cardiology', priority: 'urgent', dueAt: new Date() });
    const third = (await m.Bill.findOne({ kind: 'admission', admission: adm._id, state: 'open' }).lean()) as any;
    assert.equal(String(third.continuationOf), String(stay[1]._id));
    assert.equal(third.totals.charges, 800);

    // After the patient has left, a late charge goes where it always did: the walk-in bill.
    await settle(third._id, 800);
    await m.Admission.updateOne({ _id: adm._id }, { $set: { status: 'discharged', dischargedAt: new Date() } });
    const b = await m.ProcedureBooking.create({ number: 'PB-3', patient: patient._id, patientUhid: patient.uhid, patientName: patient.name, case: caseId, procedure: 'angiography', priority: 'urgent', requestedBy: BY, earliest: new Date() } as any);
    await deliver('scheduling', 'scheduling.procedure-done', { bookingId: String(b._id), number: 'PB-3', procedure: 'angiography', priority: 'urgent', status: 'done' });
    assert.equal(await m.Bill.countDocuments({ kind: 'admission', admission: adm._id }), 3, 'no continuation for a stay that has ended');
    assert.equal((await m.Bill.findOne({ kind: 'walk-in' }).lean())!.totals.charges, 25000);
  });

  test('the Bill settled close check fails while a continuation bill has a balance', async () => {
    await price('lab:cbc', 300);
    const { settled } = await settledStay();
    const closeCheck = () => registry.closeChecks().find((c) => c.agent === 'revenue')!.check(String(caseId));
    assert.equal(await closeCheck(), 'pass', 'the settled stay alone');
    await cbcCollected();
    assert.equal(await closeCheck(), 'fail', 'the continuation bill is open with ₹300 due');
    const next = (await m.Bill.findOne({ continuationOf: settled._id } as any).lean())!;
    await m.Bill.updateOne({ _id: next._id }, { $set: { state: 'final', finalAt: new Date() } });
    assert.equal(await closeCheck(), 'fail', 'final with ₹300 due');
    await settle(next._id, 300);
    assert.equal(await closeCheck(), 'pass', 'both bills settled');
  });

  test('a failed price lookup still charges 0 with needs price and does not throw', async () => {
    prices.priceFor = async () => {
      throw new Error('db down');
    };
    const v = await visit();
    await deliver('er', 'er.arrived', { visitId: String(v._id), visitNumber: v.number, complaint: 'x' });
    const l = (await lines())[0];
    assert.deepEqual([l.code, l.name, l.unitPrice, l.amount, l.needsPrice], ['er:registration', 'er:registration', 0, 0, true]);
  });
});
