import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Types } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentKey, MessageTypeDef } from '../coordinator/coordinator-types';
import { ApprovalsService } from '../coordinator/approvals.service';
import { ClocksService } from '../coordinator/clocks.service';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { EscalationsService } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { ER_MESSAGE_TYPES } from '../er/er-coordinator.registration';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { PriceListService } from './price-list.service';
import { CorrectionsService } from './revenue-corrections.service';
import { FinalBillService } from './revenue-final.service';
import { RevenueBillsService } from './revenue-bills.service';
import { RevenueCoordinatorRegistration } from './revenue-coordinator.registration';
import { RevenueAiService } from './revenue-ai';
import { RevenueOverviewService } from './revenue-overview.service';
import { RevenueSettingsService } from './revenue-settings.service';

const ADMIN = { id: 'a1', name: 'Admin', role: UserRole.ADMIN };
const DESK = { id: 'f1', name: 'Front Desk', role: UserRole.STAFF };

describe('CorrectionsService', () => {
  const m = models();
  let approvals: ApprovalsService;
  let bills: RevenueBillsService;
  let final: FinalBillService;
  let svc: CorrectionsService;
  let capture: { onSuggestedReversal: ((e: any) => any)[] };
  let patient: any;

  /** An ER bill with one 5000 line (charges 5000). */
  const erBill = async (opts: { final?: boolean } = {}) => {
    const b = await bills.open({ kind: 'er', patientId: String(patient._id), erVisitId: String(new Types.ObjectId()) });
    const { line } = await bills.addCharge(String(b._id), { code: 'other:x', name: 'Procedure', category: 'procedure', qty: 1, unitPrice: 5000, source: { type: 'manual', ref: String(new Types.ObjectId()) }, by: { name: 'T' } });
    if (opts.final) await final.prepare(ADMIN, String(b._id));
    return { bill: b, line };
  };
  /** An OPD bill for a Completed visit with one ₹0 Needs price line (charges 0). */
  const opdNeedsPrice = async () => {
    const visit = await m.Appointment.create({ uhid: patient.uhid, patientName: patient.name, age: 62, gender: 'Male', phone: '9100000082', time: '09:30 AM', date: isoDate(clinicNow()), type: 'Consultation', condition: 'Fever', status: 'Completed' });
    const b = await bills.open({ kind: 'opd', patientId: String(patient._id), appointmentId: String(visit._id) });
    const { line } = await bills.addCharge(String(b._id), { code: 'lab:blood-culture', name: 'Blood culture', category: 'lab', qty: 1, unitPrice: 0, needsPrice: true, source: { type: 'manual', ref: String(new Types.ObjectId()) }, by: { name: 'T' } });
    return { bill: b, line };
  };
  const overviewSvc = () => new RevenueOverviewService(m.RevenueSnapshot, m.Bill, m.ChargeLine, m.Payment, m.Refund, m.TaskAlertItem, new RevenueAiService({} as any));
  const needsPriceWarning = async (billId: unknown) => (await final.prepare(ADMIN, String(billId))).warnings.filter((w) => w.kind === 'needs-price');
  const fresh = (id: unknown) => m.Bill.findById(id).lean();
  const totals = async (id: unknown) => ({ ...(await fresh(id))!.totals });
  const decide = (c: any, d: 'approved' | 'rejected') => approvals.act(ADMIN, String(c.approvalId), d);

  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    const registry = new AgentRegistry();
    const events = new CoordinatorEvents();
    const messages = new MessagesService(m.AgentMessage, registry, events);
    const stub = (key: AgentKey, types: MessageTypeDef[]) => registry.register({ key, messageTypes: types, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
    stub('er', ER_MESSAGE_TYPES);
    const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
    await escalations.ensureDefaults();
    new ClocksService(m.Clock, registry, messages, escalations);
    approvals = new ApprovalsService(m.Approval, m.DutyTitle, registry, messages, events);
    const settings = new RevenueSettingsService(new SettingsService(m.HospitalSettings));
    const reg = new RevenueCoordinatorRegistration(registry, m.Bill, m.Refund, m.TaskAlertItem, messages);
    bills = new RevenueBillsService(m.Bill, m.ChargeLine, m.Payment, m.Refund, m.Correction, m.Estimate, m.CoordinatorCounter, m.Patient, undefined, m.Admission);
    final = new FinalBillService(messages, reg, settings, bills, m.Bill, m.ChargeLine, m.TaskAlertItem, m.PharmacyOrder, m.PharmacyLine, m.LabRequest, m.LabLine, m.Admission, m.Appointment, m.DischargeOrder);
    capture = { onSuggestedReversal: [] };
    svc = new CorrectionsService(reg, bills, approvals, final, new PriceListService(m.PriceItem, m.Ward, m.OpDoctor), capture as any, m.Correction, m.ChargeLine);
    reg.onModuleInit();
    patient = await m.Patient.create({ uhid: 'MHK202600982', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000082' });
  });

  test('a discount waits for an admin and changes the balance only when approved', async () => {
    const { bill } = await erBill();
    const c = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 500, reason: 'Staff concession' });
    assert.equal(c.state, 'pending');
    assert.ok(c.approvalId);
    assert.equal((await totals(bill._id)).balance, 5000);
    const open = await m.Approval.findById(c.approvalId).lean();
    assert.equal(open!.type, 'revenue.correction');
    assert.ok(!/Ravi/.test(open!.summary));
    await decide(c, 'approved');
    assert.deepEqual(await totals(bill._id), { charges: 5000, discounts: 500, payments: 0, refunds: 0, balance: 4500 });
    const credit = await m.ChargeLine.findOne({ 'source.type': 'correction', 'source.ref': String(c._id) }).lean();
    assert.equal(credit!.amount, -500);
    assert.equal(credit!.category, 'discount');
    assert.equal((await m.Correction.findById(c._id).lean())!.state, 'approved');
  });

  test('pressing approve twice, or retrying after a throw, applies the correction once', async () => {
    const { bill, line } = await erBill();
    const c = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 300, reason: 'Goodwill' });
    await decide(c, 'approved');
    await assert.rejects(() => decide(c, 'approved'), /Already decided/);
    assert.deepEqual(await totals(bill._id), { charges: 5000, discounts: 300, payments: 0, refunds: 0, balance: 4700 });
    // A throw while the totals move: the approval reopens and the retry applies once.
    const d = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 200, reason: 'Goodwill again' });
    const real = bills.adjust.bind(bills);
    let boom = true;
    (bills as any).adjust = async (...a: any[]) => {
      if (boom) {
        boom = false;
        throw new Error('db down');
      }
      return (real as any)(...a);
    };
    await assert.rejects(() => decide(d, 'approved'), /db down/);
    assert.equal((await m.Approval.findById(d.approvalId).lean())!.state, 'open');
    assert.equal((await totals(bill._id)).discounts, 300);
    await decide(d, 'approved');
    assert.deepEqual(await totals(bill._id), { charges: 5000, discounts: 500, payments: 0, refunds: 0, balance: 4500 });
    assert.equal(await m.ChargeLine.countDocuments({ 'source.type': 'correction', 'source.ref': String(d._id) }), 1);
    // A throw after the totals moved (the link step): the retry does not move them again.
    const e = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 100, lineId: String(line._id), reason: 'More' });
    const realUpdate = m.ChargeLine.updateOne.bind(m.ChargeLine);
    let boom2 = true;
    (m.ChargeLine as any).updateOne = (...a: any[]) => {
      if (boom2) {
        boom2 = false;
        throw new Error('link failed');
      }
      return (realUpdate as any)(...a);
    };
    try {
      await assert.rejects(() => decide(e, 'approved'), /link failed/);
      await decide(e, 'approved');
    } finally {
      (m.ChargeLine as any).updateOne = realUpdate;
    }
    assert.deepEqual(await totals(bill._id), { charges: 5000, discounts: 600, payments: 0, refunds: 0, balance: 4400 });
    assert.equal(await m.ChargeLine.countDocuments({ 'source.type': 'correction', 'source.ref': String(e._id) }), 1);
    assert.ok((await m.Correction.findById(e._id).lean())!.appliedAt);
  });

  test('a rejected correction changes nothing', async () => {
    const { bill, line } = await erBill();
    const c = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'reversal', reason: 'Wrong item' });
    await decide(c, 'rejected');
    assert.equal((await m.Correction.findById(c._id).lean())!.state, 'rejected');
    assert.deepEqual(await totals(bill._id), { charges: 5000, discounts: 0, payments: 0, refunds: 0, balance: 5000 });
    assert.equal(await m.ChargeLine.countDocuments({ bill: bill._id }), 1);
    assert.equal((await m.ChargeLine.findById(line._id).lean())!.reversed, false);
  });

  test('a reversal adds a credit line and marks the original reversed without editing it', async () => {
    const { bill, line } = await erBill();
    const c = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'reversal', reason: 'Wrong item' });
    await assert.rejects(() => svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'reversal', reason: 'Again' }), /already waiting/);
    await decide(c, 'approved');
    const original = await m.ChargeLine.findById(line._id).lean();
    assert.equal(original!.amount, 5000);
    assert.equal(original!.qty, 1);
    assert.equal(original!.reversed, true);
    assert.deepEqual(original!.corrections.map(String), [String(c._id)]);
    const credit = await m.ChargeLine.findOne({ 'source.type': 'correction', 'source.ref': String(c._id) }).lean();
    assert.equal(credit!.amount, -5000);
    assert.equal(credit!.category, 'procedure');
    assert.deepEqual(await totals(bill._id), { charges: 0, discounts: 0, payments: 0, refunds: 0, balance: 0 });
    await assert.rejects(() => svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'reversal', reason: 'Twice' }), /already reversed/);
  });

  test('a throw after the claim rolls it back, so the approval can be rejected and settling is not blocked', async () => {
    const { bill, line } = await erBill({ final: true });
    await bills.adjust(String(bill._id), { payments: 5000 });
    const c = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'discount', amount: 100, reason: 'x' });
    const realUpdate = m.ChargeLine.updateOne.bind(m.ChargeLine);
    let boom = true;
    (m.ChargeLine as any).updateOne = (...a: any[]) => {
      if (boom) {
        boom = false;
        throw new Error('link failed');
      }
      return (realUpdate as any)(...a);
    };
    try {
      await assert.rejects(() => decide(c, 'approved'), /link failed/);
    } finally {
      (m.ChargeLine as any).updateOne = realUpdate;
    }
    assert.equal((await m.Correction.findById(c._id).lean())!.state, 'pending');
    assert.equal(await m.ChargeLine.countDocuments({ 'source.type': 'correction' }), 0, 'the written line is removed');
    assert.equal((await totals(bill._id)).discounts, 0, 'the totals are put back');
    await decide(c, 'rejected');
    assert.equal((await m.Correction.findById(c._id).lean())!.state, 'rejected');
    const settled = await final.settle(ADMIN, String(bill._id));
    assert.equal(settled.state, 'settled');
  });

  test('a reversal also takes back the line\'s own discount, so the refund is what was really paid', async () => {
    const { bill, line } = await erBill({ final: true });
    await svc.request(ADMIN, { billId: String(bill._id), lineId: String(line._id), kind: 'discount', amount: 1000, reason: 'Concession' });
    await bills.adjust(String(bill._id), { payments: 4000 });
    assert.equal((await totals(bill._id)).balance, 0);
    await svc.request(ADMIN, { billId: String(bill._id), lineId: String(line._id), kind: 'reversal', reason: 'Not given' });
    assert.deepEqual(await totals(bill._id), { charges: 0, discounts: 0, payments: 4000, refunds: 0, balance: -4000 });
    const sum = await m.ChargeLine.aggregate([{ $match: { bill: bill._id } }, { $group: { _id: '$category', t: { $sum: '$amount' } } }]);
    assert.equal(sum.reduce((a: number, r: any) => a + (r._id === 'discount' ? -r.t : 0), 0), 0, 'discount lines net to 0');
    await assert.rejects(() => svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'discount', amount: 10, reason: 'x' }), /already reversed/);
  });

  test('two changes in a row use the line as it is now', async () => {
    const { bill, line } = await erBill();
    await svc.request(ADMIN, { billId: String(bill._id), lineId: String(line._id), kind: 'change', qty: 2, reason: 'Two given' });
    assert.equal((await totals(bill._id)).charges, 10000);
    await svc.request(ADMIN, { billId: String(bill._id), lineId: String(line._id), kind: 'change', unitPrice: 4000, reason: 'Wrong price' });
    assert.equal((await totals(bill._id)).charges, 8000);
  });

  test('a change moves the charge by the difference', async () => {
    const { bill, line } = await erBill();
    const c = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'change', qty: 2, unitPrice: 4000, reason: 'Wrong quantity' });
    await decide(c, 'approved');
    assert.deepEqual(await totals(bill._id), { charges: 8000, discounts: 0, payments: 0, refunds: 0, balance: 8000 });
    assert.equal((await m.ChargeLine.findById(line._id).lean())!.amount, 5000);
  });

  test('R44: an approved price change on a Needs price line clears the flag, so the Prepare warning, the overview and R20 stop seeing it', async () => {
    const { bill, line } = await opdNeedsPrice();
    const overview = overviewSvc();
    assert.equal(await final.autoSettleOpd(String(bill._id)), false, 'R20 holds the bill while a line needs a price');
    assert.equal((await overview.overview()).needsPrice.length, 1);
    assert.equal((await needsPriceWarning(bill._id)).length, 1);
    const c = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'change', unitPrice: 1200, reason: 'Outside lab price' });
    await decide(c, 'approved');
    const original = await m.ChargeLine.findById(line._id).lean();
    assert.equal(original!.needsPrice, false);
    assert.equal(original!.amount, 0, 'the original line keeps its money; the change is its own line');
    assert.deepEqual(original!.corrections.map(String), [String(c._id)], 'the correction stays linked');
    assert.equal((await m.ChargeLine.findOne({ 'source.ref': String(c._id) }).lean())!.amount, 1200);
    assert.deepEqual(await totals(bill._id), { charges: 1200, discounts: 0, payments: 0, refunds: 0, balance: 1200 });
    assert.deepEqual((await overview.overview()).needsPrice, []);
    assert.deepEqual(await needsPriceWarning(bill._id), []);
    await bills.adjust(String(bill._id), { payments: 1200 });
    assert.equal(await final.autoSettleOpd(String(bill._id)), true, 'R20 no longer holds the bill');
    assert.equal((await fresh(bill._id))!.state, 'settled');
  });

  test('R44: a change to ₹0 on a Needs price line confirms it as free: the flag clears, no money moves and it is not voided', async () => {
    const { bill, line } = await opdNeedsPrice();
    const before = await totals(bill._id);
    const c = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'change', unitPrice: 0, reason: 'Free of charge' });
    await decide(c, 'approved');
    const done = await m.Correction.findById(c._id).lean();
    assert.equal(done!.state, 'approved');
    assert.ok(done!.appliedAt);
    assert.equal(done!.delta, 0);
    const original = await m.ChargeLine.findById(line._id).lean();
    assert.equal(original!.needsPrice, false);
    assert.deepEqual(original!.corrections.map(String), [String(c._id)]);
    assert.equal(await m.ChargeLine.countDocuments({ 'source.type': 'correction' }), 0, 'no money line is written');
    assert.deepEqual(await totals(bill._id), before);
    assert.deepEqual((await overviewSvc().overview()).needsPrice, []);
    assert.equal(await final.autoSettleOpd(String(bill._id)), true, 'nothing due and nothing unpriced: R20 settles it');
    // An admin's own confirmation applies at once; an unchanged amount on a priced line is still voided.
    const er = await erBill();
    const { line: free } = await bills.addCharge(String(er.bill._id), { code: 'cons:gauze', name: 'Gauze', category: 'consumables', qty: 2, unitPrice: 0, needsPrice: true, source: { type: 'manual', ref: String(new Types.ObjectId()) }, by: { name: 'T' } });
    const own = await svc.request(ADMIN, { billId: String(er.bill._id), lineId: String(free._id), kind: 'change', unitPrice: 0, reason: 'Given free' });
    assert.ok(own!.appliedAt);
    assert.equal((await m.ChargeLine.findById(free._id).lean())!.needsPrice, false);
    const same = await svc.request(ADMIN, { billId: String(er.bill._id), lineId: String(er.line._id), kind: 'change', unitPrice: 5000, reason: 'Same' });
    assert.equal(same!.state, 'void');
    assert.equal((await totals(er.bill._id)).charges, 5000);
  });

  test('R44: a failed flag clear never undoes the applied price, and confirming the price again clears it', async () => {
    const { bill, line } = await opdNeedsPrice();
    const realUpdate = m.ChargeLine.updateOne.bind(m.ChargeLine);
    (m.ChargeLine as any).updateOne = (filter: any, update: any, ...rest: any[]) => {
      if (update?.$set?.needsPrice === false) throw new Error('flag write failed');
      return (realUpdate as any)(filter, update, ...rest);
    };
    let c: any;
    try {
      c = await svc.request(ADMIN, { billId: String(bill._id), lineId: String(line._id), kind: 'change', unitPrice: 800, reason: 'Outside lab price' });
    } finally {
      (m.ChargeLine as any).updateOne = realUpdate;
    }
    assert.ok(c.appliedAt, 'the correction is applied, not rolled back');
    assert.deepEqual(await totals(bill._id), { charges: 800, discounts: 0, payments: 0, refunds: 0, balance: 800 });
    assert.equal((await m.ChargeLine.findById(line._id).lean())!.needsPrice, true);
    const again = await svc.request(ADMIN, { billId: String(bill._id), lineId: String(line._id), kind: 'change', unitPrice: 800, reason: 'Price confirmed' });
    assert.ok(again!.appliedAt);
    assert.equal(again!.delta, 0);
    assert.equal((await m.ChargeLine.findById(line._id).lean())!.needsPrice, false);
    assert.equal((await totals(bill._id)).charges, 800, 'confirming moves no money');
  });

  test('a reversed line no longer counts as needing a price in the Prepare warning or R20', async () => {
    const { bill, line } = await opdNeedsPrice();
    await m.ChargeLine.updateOne({ _id: line._id }, { $set: { reversed: true } });
    assert.deepEqual(await needsPriceWarning(bill._id), []);
    assert.equal(await final.autoSettleOpd(String(bill._id)), true);
  });

  test('an admin\'s own write-off applies at once and settles a zero balance', async () => {
    const { bill } = await erBill({ final: true });
    await bills.adjust(String(bill._id), { payments: 4800 });
    const c = await svc.request(ADMIN, { billId: String(bill._id), kind: 'writeoff', amount: 900, reason: 'Patient cannot pay' });
    assert.equal(c.state, 'approved');
    assert.ok(c.appliedAt);
    const after = await fresh(bill._id);
    assert.equal(after!.state, 'settled');
    assert.deepEqual({ ...after!.totals }, { charges: 5000, discounts: 200, payments: 4800, refunds: 0, balance: 0 });
    const credit = await m.ChargeLine.findOne({ 'source.ref': String(c._id) }).lean();
    assert.equal(credit!.category, 'write-off');
    assert.equal(credit!.amount, -200);
  });

  test('a write-off on an open ER bill needs the final bill first', async () => {
    const { bill } = await erBill();
    await assert.rejects(() => svc.request(ADMIN, { billId: String(bill._id), kind: 'writeoff', amount: 100, reason: 'x' }), /Prepare the final bill first/);
  });

  test('settling waits while a correction is pending, and a settled bill takes no correction', async () => {
    const { bill, line } = await erBill({ final: true });
    await bills.adjust(String(bill._id), { payments: 5000 });
    const c = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'change', unitPrice: 4000, reason: 'Wrong price' });
    await assert.rejects(() => final.settle(ADMIN, String(bill._id)), /A correction or refund is waiting/);
    await decide(c, 'rejected');
    await final.settle(ADMIN, String(bill._id));
    await assert.rejects(() => svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 1, reason: 'x' }), /settled/);
  });

  test('an approved correction on a bill that settled meanwhile is voided, not thrown', async () => {
    const { bill } = await erBill({ final: true });
    await bills.adjust(String(bill._id), { payments: 5000 });
    const c = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 100, reason: 'x' });
    await m.Bill.updateOne({ _id: bill._id }, { $set: { state: 'settled' } });
    await decide(c, 'approved');
    const after = await m.Correction.findById(c._id).lean();
    assert.equal(after!.state, 'void');
    assert.match(after!.voidReason ?? '', /settled/);
    assert.equal((await totals(bill._id)).discounts, 0);
  });

  test('a suggested reversal is one pending correction per charge line, even when replayed', async () => {
    const { bill, line } = await erBill();
    assert.equal(capture.onSuggestedReversal.length, 1);
    const event = { billId: String(bill._id), lineId: String(line._id), reason: 'Lab test crp was cancelled after it was charged' };
    await capture.onSuggestedReversal[0](event);
    await capture.onSuggestedReversal[0](event);
    const all = await m.Correction.find({ bill: bill._id }).lean();
    assert.equal(all.length, 1);
    assert.equal(all[0].suggested, true);
    assert.equal(all[0].state, 'pending');
    assert.equal(await m.Approval.countDocuments({ type: 'revenue.correction' }), 1);
    await decide(all[0], 'rejected');
    await capture.onSuggestedReversal[0](event); // rejected once: not suggested again
    assert.equal(await m.Correction.countDocuments({ bill: bill._id }), 1);
  });

  test('a missed charge is added by the desk, with a price-list code filling the name and price', async () => {
    const { bill } = await erBill();
    await m.PriceItem.create({ code: 'cons:iv-set', name: 'IV set', category: 'consumables', price: 250, unit: 'each', active: true });
    const line = await svc.addMissed(DESK, String(bill._id), { code: 'cons:iv-set', category: 'consumables', qty: 2, reason: 'Forgot to bill' });
    assert.equal(line.name, 'IV set');
    assert.equal(line.unitPrice, 250);
    assert.equal(line.source.type, 'manual');
    assert.equal(line.reason, 'Forgot to bill');
    assert.equal((await totals(bill._id)).charges, 5500);
    await assert.rejects(() => svc.addMissed(DESK, String(bill._id), { name: 'x', category: 'other', qty: 1, unitPrice: 5, reason: '' }), /Say why/);
  });
  test('listPending shows waiting corrections with their bill and line, and leaves out applied and rejected ones', async () => {
    const { bill, line } = await erBill();
    const waiting = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 500, reason: 'Staff concession' });
    const onLine = await svc.request(DESK, { billId: String(bill._id), lineId: String(line._id), kind: 'change', unitPrice: 4000, reason: 'Wrong rate' });
    const done = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 100, reason: 'Applied one' });
    const no = await svc.request(DESK, { billId: String(bill._id), kind: 'discount', amount: 200, reason: 'Rejected one' });
    await decide(done, 'approved');
    await decide(no, 'rejected');
    const rows = await svc.listPending();
    assert.equal(rows.length, 2);
    const byId = Object.fromEntries(rows.map((r) => [r.recordId, r]));
    assert.equal(byId[String(waiting._id)].approvalId, String(waiting.approvalId));
    assert.equal(byId[String(waiting._id)].type, 'correction');
    assert.equal(byId[String(waiting._id)].kind, 'discount');
    assert.equal(byId[String(waiting._id)].amount, 500);
    assert.equal(byId[String(waiting._id)].reason, 'Staff concession');
    assert.equal(byId[String(waiting._id)].requestedBy, 'Front Desk');
    assert.equal(byId[String(waiting._id)].bill.number, bill.number);
    assert.equal(byId[String(waiting._id)].bill.kind, 'er');
    assert.equal(byId[String(waiting._id)].line, undefined);
    assert.deepEqual(byId[String(onLine._id)].line, { id: String(line._id), name: 'Procedure', amount: 5000 });
    assert.equal(byId[String(onLine._id)].unitPrice, 4000);
    assert.ok(!Number.isNaN(Date.parse(byId[String(waiting._id)].requestedAt)));
  });
});
