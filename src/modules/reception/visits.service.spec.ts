import * as assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { QueueService } from '../queue/queue.service';
import { QueueEvents } from '../queue/queue-events';
import { PatientCardsService } from '../queue/patient-cards.service';
import { OpdService } from '../opd/opd.service';
import { SettingsService } from '../settings/settings.service';
import { AppointmentEvents } from '../appointments/appointment-events';
import { PatientsService } from '../patients/patients.service';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CoordinatorEvents } from '../coordinator/coordinator-events';
import { MessagesService } from '../coordinator/messages.service';
import { PriceListService } from '../revenue/price-list.service';
import { RevenueBillsService } from '../revenue/revenue-bills.service';
import { RevenueCoordinatorRegistration } from '../revenue/revenue-coordinator.registration';
import { FinalBillService } from '../revenue/revenue-final.service';
import { RevenueKioskService } from '../revenue/revenue-kiosk.service';
import { RevenueOpdService } from '../revenue/revenue-opd.service';
import { PaymentsService } from '../revenue/revenue-payments.service';
import { RevenueSettingsService } from '../revenue/revenue-settings.service';
import { ReceptionIdentityService } from './identity.service';
import { OpVisitsService } from './visits.service';
import { PaymentProvider, SamplePaymentProvider } from './providers/payment-provider';
import { newSecret, sha256 } from './format';
import { KioskRef } from './reception.types';

// OP numbers and tokens come from the clinic day; availability from the clinic time.
process.env.TZ = 'Asia/Kolkata';
const savedClinicDate = process.env.CLINIC_DATE;
process.env.CLINIC_DATE = '2026-09-26';

const kiosk: KioskRef = { id: 'k1', name: 'Front kiosk' };
const otherKiosk: KioskRef = { id: 'k2', name: 'Side kiosk' };

const responseOf = (error: unknown) => (error as { getResponse(): Record<string, any> }).getResponse();
const statusOf = (error: unknown) => (error as { getStatus(): number }).getStatus();
const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (e) => {
    assert.equal(responseOf(e).code, code);
    return true;
  });
};
const rejects404 = async (promise: Promise<unknown>) => {
  await assert.rejects(promise, (e) => {
    assert.equal(statusOf(e), 404);
    return true;
  });
};

describe('OpVisitsService', () => {
  const m = () => models();
  let service: OpVisitsService;
  let queue: QueueService;
  let revenue: RevenueKioskService;
  let revenueOpd: RevenueOpdService;
  let clock: Date;
  let docA: string;
  let docB: string;
  let docDone: string;

  /** The Revenue Agent as the app wires it, on the same appointment events as the queue. */
  const buildRevenue = (settings: SettingsService, appointmentEvents: AppointmentEvents) => {
    const registry = new AgentRegistry();
    const messages = new MessagesService(m().AgentMessage, registry, new CoordinatorEvents());
    const reg = new RevenueCoordinatorRegistration(registry, m().Bill, m().Refund, m().TaskAlertItem, messages);
    const bills = new RevenueBillsService(m().Bill, m().ChargeLine, m().Payment, m().Refund, m().Correction, m().Estimate, m().CoordinatorCounter, m().Patient);
    const prices = new PriceListService(m().PriceItem, m().Ward, m().OpDoctor);
    const revenueSettings = new RevenueSettingsService(settings);
    const final = new FinalBillService(messages, reg, revenueSettings, bills, m().Bill, m().ChargeLine, m().TaskAlertItem, m().PharmacyOrder, m().PharmacyLine, m().LabRequest, m().LabLine, m().Admission, m().Appointment);
    const payments = new PaymentsService(reg, revenueSettings, bills, final, m().Payment);
    revenueOpd = new RevenueOpdService(appointmentEvents, prices, bills, m().Appointment, m().Patient, m().ChargeLine, final);
    reg.onModuleInit();
    return new RevenueKioskService(revenueOpd, bills, payments, m().Patient, m().ChargeLine, m().Payment);
  };

  const build = (payments: PaymentProvider | null) => {
    const settings = new SettingsService(m().HospitalSettings);
    const opd = new OpdService(m().Department, m().OpDoctor, settings);
    const appointmentEvents = new AppointmentEvents();
    queue = new QueueService(m().QueueToken, m().QueueSequence, m().Appointment, m().Patient, settings, new QueueEvents(), appointmentEvents, opd);
    const cards = new PatientCardsService(m().PatientCard, m().Patient, queue);
    const config = { get: (key: string) => (key === 'jwt.secret' ? 'test-secret-test-secret-test-secret-1234' : key === 'reception.publicWebUrl' ? 'https://web.example' : undefined) } as unknown as ConfigService;
    const now = () => clock;
    const identity = new ReceptionIdentityService(m().ReceptionSession, m().OtpChallenge, m().Patient, m().Appointment, new PatientsService(m().Patient), cards, queue, settings, config, null, now);
    revenue = buildRevenue(settings, appointmentEvents);
    return new OpVisitsService(m().OpVisit, m().OpSequence, m().Patient, identity, opd, queue, revenue, settings, config, payments, now);
  };

  /** The visit's Revenue records: its consultation lines, its kiosk payment(s), and the bill they sit on. */
  const revenueOf = async (visitId: string) => {
    const payments = await m().Payment.find({ source: `op-visit:${visitId}` }).lean();
    const bill = payments[0] ? await m().Bill.findById(payments[0].bill).lean() : null;
    const lines = bill ? await m().ChargeLine.find({ bill: bill._id, category: 'consultation' }).lean() : [];
    return { payments, bill, lines };
  };

  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };

  /** A patient identified at `at`, as the kiosk would hold them. */
  const sessionFor = async (uhid: string, at: KioskRef = kiosk) => {
    if (!(await m().Patient.exists({ uhid }))) {
      await m().Patient.create({ uhid, name: `Patient ${uhid}`, phone: '9876543210', gender: 'Male', age: 30 } as any);
    }
    const session = newSecret();
    await m().ReceptionSession.create({ tokenHash: sha256(session), uhid, kioskId: at.id, via: 'card', expiresAt: new Date(clock.getTime() + 15 * 60_000) });
    return session;
  };

  const visitWith = async (uhid: string, method: 'UPI' | 'CASH' | 'CARD', doctorId = docA) => {
    const visit = await service.create(kiosk, await sessionFor(uhid), doctorId);
    return service.pay(kiosk, visit.id, method);
  };

  /** A visit some request switched to paid and then left; `finishingUntil` is its finishing lease. */
  const markPaid = (id: string, finishingUntil: Date, extra: Record<string, unknown> = {}) =>
    m().OpVisit.updateOne({ _id: id }, { $set: { status: 'paid', paidAt: clock, transactionId: 'T-STOPPED', confirmedBy: 'Gateway', finishingUntil, ...extra } });

  before(connectTestDb);
  after(async () => {
    if (savedClinicDate === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinicDate;
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    process.env.CLINIC_DATE = '2026-09-26';
    clock = new Date('2026-09-26T04:30:00.000Z'); // Saturday 10:00 AM in Kolkata
    await m().Department.create({ code: 'general-medicine', name: 'General Medicine', tokenPrefix: 'G', order: 1 } as any);
    const everyDay = [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '22:00' }];
    const a = await m().OpDoctor.create({ name: 'Dr. A', departmentCode: 'general-medicine', room: 'Room 101', tokenPrefix: 'G', fee: 300, sessions: everyDay } as any);
    const b = await m().OpDoctor.create({ name: 'Dr. B', departmentCode: 'general-medicine', room: 'Room 102', tokenPrefix: 'G2', fee: 450, sessions: everyDay } as any);
    const done = await m().OpDoctor.create({ name: 'Dr. Early', departmentCode: 'general-medicine', room: 'Room 102', tokenPrefix: 'G3', fee: 300, sessions: [{ days: [6], start: '07:00', end: '09:00' }] } as any);
    docA = String(a._id);
    docB = String(b._id);
    docDone = String(done._id);
    await m().HospitalSettings.create({
      hospital: { name: "St. Mary's" },
      queue: { counters: ['Room 101', 'Room 102'] },
      reception: { defaultDoctorId: docA, upiPayeeName: "St. Mary's Multi Speciality Hospital" },
    } as any);
    service = build(new SamplePaymentProvider(() => clock));
  });

  test('full cash path', async () => {
    const visit = await service.create(kiosk, await sessionFor('U1'), docA);
    assert.equal(visit.status, 'awaiting-payment');
    assert.equal(visit.fee, 300);
    assert.deepEqual(visit.doctor, { id: docA, name: 'Dr. A', department: 'General Medicine', room: 'Room 101' });
    assert.deepEqual(visit.patient, { name: 'Patient U1', uhid: 'U1' });
    assert.equal(visit.kioskName, 'Front kiosk');
    assert.equal(visit.via, 'card');
    assert.equal(visit.expiresAt, new Date(clock.getTime() + 15 * 60_000).toISOString());

    const cash = await service.pay(kiosk, visit.id, 'CASH');
    assert.equal(cash.method, 'CASH');
    assert.match(cash.paymentCode!, /^\d{4}$/);
    assert.equal(cash.sample, false);
    assert.equal(cash.upiUri, undefined);
    assert.equal(cash.expiresAt, new Date(clock.getTime() + 30 * 60_000).toISOString());
    assert.deepEqual((await service.list({ status: 'awaiting-cash' })).map((v) => v.id), [visit.id]);

    const paid = await service.confirmCash(visit.id, 'Anita');
    assert.equal(paid.status, 'paid');
    assert.equal(paid.opNumber, 'OP-20260926-0001');
    assert.equal(paid.token?.label, 'G-001');
    assert.equal(paid.token?.doctorName, 'Dr. A');
    assert.equal(paid.token?.room, 'Room 101');
    assert.match(paid.token!.trackUrl, /^https:\/\/web\.example\/track#.+/);
    assert.equal(paid.billNumber, 'BL-0001');
    assert.equal(paid.receiptNumber, 'RC-0001');
    assert.equal(paid.paidAt, clock.toISOString());
    assert.equal(paid.paidAtDisplay, '26 Sep 2026, 10:00 AM');
    assert.deepEqual(await service.list({ status: 'awaiting-cash' }), []);
    assert.deepEqual((await service.list({ status: 'paid' })).map((v) => v.opNumber), ['OP-20260926-0001']);

    // The Revenue Agent has it (no appointment: a walk-in bill), and no old invoice is written.
    assert.equal(await m().BillInvoice.countDocuments({}), 0);
    const { payments, bill, lines } = await revenueOf(visit.id);
    assert.equal(bill!.number, 'BL-0001');
    assert.equal(bill!.kind, 'walk-in');
    assert.equal(bill!.patientUhid, 'U1');
    assert.equal(bill!.day, '2026-09-26');
    assert.deepEqual([bill!.totals.charges, bill!.totals.payments, bill!.totals.balance], [300, 300, 0]);
    assert.deepEqual(
      lines.map(({ name, category, qty, unitPrice, amount, source }) => ({ name, category, qty, unitPrice, amount, source })),
      [{ name: 'Consultation - Dr. A', category: 'consultation', qty: 1, unitPrice: 300, amount: 300, source: { type: 'op-visit', ref: visit.id } }],
    );
    assert.equal(payments.length, 1);
    assert.deepEqual(
      { receipt: payments[0].receiptNumber, amount: payments[0].amount, mode: payments[0].mode, kind: payments[0].kind, reference: payments[0].reference, by: payments[0].by.name },
      { receipt: 'RC-0001', amount: 300, mode: 'kiosk', kind: 'settlement', reference: 'Cash at counter', by: 'Anita' },
    );

    const tokens = await m().QueueToken.find({}).lean();
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].source, 'kiosk');
    assert.equal(tokens[0].issuedBy, 'Anita');
    const stored = await m().OpVisit.findById(visit.id).lean();
    assert.equal(stored!.tokenId, String(tokens[0]._id));
    assert.equal(stored!.billId, String(bill!._id));
    assert.equal(stored!.confirmedBy, 'Anita');

    // Paid is final: no cancel, and a second confirm changes nothing.
    await rejectsWith(service.cancel(visit.id, { actor: 'Ravi' }), 'VISIT_CLOSED');
    assert.equal((await service.confirmCash(visit.id, 'Ravi')).opNumber, 'OP-20260926-0001');
    assert.equal((await m().OpVisit.findById(visit.id).lean())!.status, 'paid');
  });

  test('complete twice gives one token and one bill', async () => {
    const visit = await visitWith('U1', 'UPI');
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => service.complete(visit.id, { actor: 'Gateway', transactionId: `T${i}` })));
    for (const r of results) {
      assert.equal(r.status, 'paid');
      assert.equal(r.opNumber, 'OP-20260926-0001');
      assert.equal(r.token?.label, 'G-001');
      assert.equal(r.billNumber, 'BL-0001');
      assert.equal(r.receiptNumber, 'RC-0001');
      assert.equal(r.transactionId, results[0].transactionId);
    }
    assert.equal(await m().QueueToken.countDocuments({}), 1);
    const { payments, lines } = await revenueOf(visit.id);
    assert.deepEqual([payments.length, lines.length], [1, 1]);
    assert.equal(payments[0].reference, `UPI · ${results[0].transactionId} · SAMPLE`);
    assert.equal(await m().Payment.countDocuments({}), 1);
    const events = (await m().OpVisit.findById(visit.id).lean())!.history.map((h) => h.event);
    assert.deepEqual(events.slice(2), [`Payment received (${results[0].transactionId})`, 'OP number OP-20260926-0001', 'Token G-001 issued', 'Bill BL-0001: ₹300 paid by UPI, receipt RC-0001']);

    // The losers took no OP number: the next visit gets the next one.
    const next = await visitWith('U2', 'CARD');
    assert.equal((await service.sampleComplete(kiosk, next.id)).opNumber, 'OP-20260926-0002');
  });

  test('a poll during completion never sees a half-built paid visit', async () => {
    for (let i = 0; i < 5; i++) {
      const visit = await visitWith(`P${i}`, 'UPI');
      const [, polled] = await Promise.all([service.sampleComplete(kiosk, visit.id), service.getForKiosk(kiosk, visit.id)]);
      if (polled.status === 'paid') {
        assert.ok(polled.opNumber && polled.token && polled.billNumber, `poll ${i} returned a paid visit without its OP number, token or bill`);
      } else {
        assert.equal(polled.status, 'awaiting-payment');
      }
    }
  });

  test('confirm and cancel race leaves one consistent outcome', async () => {
    for (let i = 0; i < 8; i++) {
      const uhid = `R${i}`;
      const visit = await visitWith(uhid, 'CASH');
      const confirm = () => service.confirmCash(visit.id, 'Anita');
      const cancel = () => service.cancel(visit.id, { actor: 'Ravi' });
      const [first, second] = await Promise.allSettled(i % 2 ? [confirm(), cancel()] : [cancel(), confirm()]);
      const [confirmed, cancelled] = i % 2 ? [first, second] : [second, first];

      const stored = await m().OpVisit.findById(visit.id).lean();
      const tokens = await m().QueueToken.countDocuments({ uhid });
      const bills = await m().Payment.countDocuments({ source: `op-visit:${visit.id}` });
      if (stored!.status === 'paid') {
        assert.equal(confirmed.status, 'fulfilled');
        assert.equal(cancelled.status, 'rejected');
        assert.deepEqual([tokens, bills], [1, 1]);
        assert.ok(stored!.opNumber && stored!.tokenId && stored!.billId);
      } else {
        assert.equal(stored!.status, 'cancelled');
        assert.equal(cancelled.status, 'fulfilled');
        assert.equal(confirmed.status, 'rejected');
        assert.equal(responseOf((confirmed as PromiseRejectedResult).reason).code, 'VISIT_CLOSED');
        assert.deepEqual([tokens, bills], [0, 0]);
        assert.equal(stored!.opNumber, undefined);
      }
    }
  });

  test('completion when patient already holds a token returns that token', async () => {
    const visit = await visitWith('U1', 'UPI', docB);
    const desk = await queue.issue({ uhid: 'U1' }, 'Front desk'); // issued at the desk while the patient was paying

    const paid = await service.sampleComplete(kiosk, visit.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.token?.label, desk.token.label);
    assert.equal(paid.opNumber, 'OP-20260926-0001');
    assert.ok(paid.billNumber);
    const stored = await m().OpVisit.findById(visit.id).lean();
    assert.equal(stored!.tokenId, String(desk.token._id));
    assert.ok(stored!.history.some((h) => h.event.startsWith(`Patient already held token ${desk.token.label}`)));

    const again = await service.sampleComplete(kiosk, visit.id);
    assert.equal(again.token?.label, desk.token.label);
    assert.equal(again.billNumber, paid.billNumber);
    assert.equal(await m().QueueToken.countDocuments({}), 1);
    assert.equal(await m().Payment.countDocuments({}), 1);
    // The desk token is not Dr. B's: the visit's own consultation is charged and paid.
    const { lines, bill } = await revenueOf(visit.id);
    assert.deepEqual(lines.map((l) => [l.name, l.amount, l.source.type]), [['Consultation - Dr. B', 450, 'op-visit']]);
    assert.equal(bill!.totals.balance, 0);
  });

  test('a repeat completion finishes a visit a stopped request left half-done', async () => {
    const visit = await visitWith('U1', 'UPI');
    // The request that won the switch holds the finishing lease but has not added anything yet.
    await m().OpVisit.updateOne(
      { _id: visit.id },
      { $set: { status: 'paid', paidAt: clock, transactionId: 'T1', confirmedBy: 'Gateway', finishingUntil: new Date(clock.getTime() + 30_000) } },
    );
    const repeat = service.complete(visit.id, { actor: 'Gateway', transactionId: 'T1' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // While that request may still be working, the repeat waits instead of taking an OP number.
    assert.equal(await m().OpSequence.countDocuments({}), 0);
    assert.equal(await m().QueueToken.countDocuments({}), 0);
    // Its lease runs out: it stopped, so the repeat takes over.
    advance(31);
    const healed = await repeat;
    assert.equal(healed.opNumber, 'OP-20260926-0001');
    assert.equal(healed.token?.label, 'G-001');
    assert.equal(healed.billNumber, 'BL-0001');
    assert.equal((await revenueOf(visit.id)).payments.length, 1);

    // Another stopped after its OP number and token, before the bill.
    const second = await visitWith('U2', 'UPI');
    await markPaid(second.id, clock, { opNumber: 'OP-20260926-0002' });
    await m().OpSequence.updateOne({ date: '2026-09-26' }, { $set: { last: 2 } });
    const token = await queue.issue({ uhid: 'U2', doctorId: docA }, 'Gateway', 'kiosk');
    await m().OpVisit.updateOne({ _id: second.id }, { $set: { tokenId: String(token.token._id), tokenLabel: token.token.label } });
    const again = await service.complete(second.id, { actor: 'Gateway', transactionId: 'T2' });
    assert.equal(again.opNumber, 'OP-20260926-0002');
    assert.equal(again.token?.label, 'G-002');
    assert.equal(again.billNumber, 'BL-0002');
    assert.equal((await m().OpSequence.findOne({}).lean())!.last, 2);

    // And one stopped after the Revenue Agent took its payment, before the visit stored the bill: it is not paid twice.
    await m().OpVisit.updateOne({ _id: second.id }, { $unset: { billId: 1, billNumber: 1, receiptNumber: 1 } });
    const third = await service.complete(second.id, { actor: 'Gateway', transactionId: 'T2' });
    assert.equal(third.billNumber, again.billNumber);
    assert.equal(third.receiptNumber, again.receiptNumber);
    const { payments, lines } = await revenueOf(second.id);
    assert.deepEqual([payments.length, lines.length], [1, 1]);
    assert.equal(await m().QueueToken.countDocuments({ uhid: 'U2' }), 1);
  });

  test('doctor deactivated between booking and payment still gets a token and a bill', async () => {
    const visit = await visitWith('U1', 'CASH', docB);
    await m().OpDoctor.updateOne({ _id: docB }, { $set: { active: false } });
    const paid = await service.confirmCash(visit.id, 'Anita');
    assert.equal(paid.status, 'paid');
    assert.equal(paid.opNumber, 'OP-20260926-0001');
    assert.equal(paid.token?.label, 'G2-001');
    assert.equal(paid.token?.doctorName, 'Dr. B');
    assert.equal(paid.billNumber, 'BL-0001');
    assert.equal((await revenueOf(paid.id)).payments.length, 1);
    assert.deepEqual(await service.list({ status: 'awaiting-cash' }), []);
  });

  test('a kiosk poll answers with the stored visit when finishing it fails, and the staff list finishes it later', async () => {
    const visit = await visitWith('U1', 'UPI');
    const warnings: string[] = [];
    (service as unknown as { logger: { warn(message: string): void } }).logger = { warn: (message) => warnings.push(message) };
    const issue = queue.issue;
    queue.issue = async () => {
      throw new Error('queue unavailable');
    };

    // The payment is recorded with its OP number even though the token failed; the bill waits for the token.
    await assert.rejects(service.sampleComplete(kiosk, visit.id), /queue unavailable/);
    const polled = await service.getForKiosk(kiosk, visit.id);
    assert.equal(polled.status, 'paid');
    assert.equal(polled.opNumber, 'OP-20260926-0001');
    assert.equal(polled.billNumber, undefined);
    assert.equal(polled.token, undefined);
    assert.equal(warnings.length, 1);
    // The staff list keeps working, shows it as needing attention, and logs the failed retry.
    assert.deepEqual((await service.list({ status: 'needs-attention' })).map((v) => v.id), [visit.id]);
    assert.equal(warnings.length, 2);

    queue.issue = issue;
    assert.deepEqual(await service.list({ status: 'needs-attention' }), []);
    const [healed] = await service.list({ status: 'paid' });
    assert.equal(healed.token?.label, 'G-001');
    assert.equal(healed.billNumber, 'BL-0001');
    assert.equal(await m().Payment.countDocuments({}), 1);
    assert.equal((await m().OpSequence.findOne({}).lean())!.last, 1);
  });

  test('a paid visit with no token or bill and an expired lease is finished by the next list call', async () => {
    const live = await visitWith('U1', 'UPI');
    await markPaid(live.id, new Date(clock.getTime() + 30_000));
    // Its finishing request may still be working: left alone, and not flagged yet.
    assert.deepEqual(await service.list({ status: 'needs-attention' }), []);
    assert.equal(await m().QueueToken.countDocuments({}), 0);
    advance(31);
    assert.deepEqual(await service.list({ status: 'needs-attention' }), []); // finished before listing
    const [listed] = await service.list({ status: 'paid' });
    assert.equal(listed.token?.label, 'G-001');
    assert.equal(listed.billNumber, 'BL-0001');

    // At most five are finished per call.
    for (let i = 0; i < 7; i++) await markPaid((await visitWith(`S${i}`, 'UPI')).id, clock);
    await service.list({});
    assert.equal(await m().OpVisit.countDocuments({ status: 'paid', tokenId: { $exists: true } }), 1 + 5);
    await service.list({});
    assert.equal(await m().OpVisit.countDocuments({ status: 'paid', tokenId: { $exists: true } }), 1 + 7);
    assert.equal(await m().Payment.countDocuments({ mode: 'kiosk' }), 8);
  });

  test('cash confirm is refused once the patient switched to UPI', async () => {
    const visit = await visitWith('U1', 'CASH');
    await service.pay(kiosk, visit.id, 'UPI');
    await assert.rejects(service.confirmCash(visit.id, 'Anita'), (e) => {
      assert.equal(statusOf(e), 409);
      assert.equal(responseOf(e).message, 'This visit is not waiting for a cash payment.');
      return true;
    });
    const stored = await m().OpVisit.findById(visit.id).lean();
    assert.equal(stored!.status, 'awaiting-payment');
    assert.equal(stored!.paymentCode, undefined);
    assert.equal(await m().QueueToken.countDocuments({}), 0);
  });

  test('kiosk cannot cancel a cash visit', async () => {
    const cash = await visitWith('U1', 'CASH');
    const unchanged = await service.cancel(cash.id, { actor: 'Kiosk: Front kiosk', kioskId: kiosk.id });
    assert.equal(unchanged.status, 'awaiting-payment');
    assert.equal((await service.cancel(cash.id, { actor: 'Ravi' })).status, 'cancelled');

    const upi = await visitWith('U2', 'UPI');
    await rejects404(service.cancel(upi.id, { actor: 'Kiosk: Side kiosk', kioskId: otherKiosk.id }));
    assert.equal((await service.cancel(upi.id, { actor: 'Kiosk: Front kiosk', kioskId: kiosk.id })).status, 'cancelled');
    await rejectsWith(service.sampleComplete(kiosk, upi.id), 'VISIT_CLOSED');
  });

  test("kiosk cannot read another kiosk's visit", async () => {
    const visit = await visitWith('U1', 'UPI');
    await rejects404(service.getForKiosk(otherKiosk, visit.id));
    await rejects404(service.pay(otherKiosk, visit.id, 'CASH'));
    await rejects404(service.sampleComplete(otherKiosk, visit.id));
    await rejects404(service.getForKiosk(kiosk, 'not-an-id'));
    assert.equal((await service.getForKiosk(kiosk, visit.id)).id, visit.id);
  });

  test('expired visit cannot be completed', async () => {
    const visit = await visitWith('U1', 'UPI');
    assert.equal(visit.expiresAt, new Date(clock.getTime() + 5 * 60_000).toISOString());
    advance(5 * 60 + 1);
    await rejectsWith(service.sampleComplete(kiosk, visit.id), 'VISIT_CLOSED');
    await rejectsWith(service.pay(kiosk, visit.id, 'CASH'), 'VISIT_CLOSED');
    const [listed] = await service.list({ status: 'all' });
    assert.equal(listed.status, 'expired');
    assert.equal(await m().QueueToken.countDocuments({}), 0);
    assert.equal(await m().Payment.countDocuments({}), 0);

    // No method chosen: open for 15 minutes.
    const open = await service.create(kiosk, await sessionFor('U2'), docA);
    advance(14 * 60);
    assert.equal((await service.getForKiosk(kiosk, open.id)).status, 'awaiting-payment');
    advance(61);
    assert.equal((await service.getForKiosk(kiosk, open.id)).status, 'expired');

    // Cash waits 30 minutes for the counter; a confirm after that is refused.
    const cash = await visitWith('U3', 'CASH');
    advance(30 * 60 + 1);
    await rejectsWith(service.confirmCash(cash.id, 'Anita'), 'VISIT_CLOSED');
    assert.equal((await m().OpVisit.findById(cash.id).lean())!.status, 'expired');
    assert.equal(await m().QueueToken.countDocuments({}), 0);
  });

  test('create is refused when the patient holds a token', async () => {
    const session = await sessionFor('U1');
    const desk = await queue.issue({ uhid: 'U1' }, 'Front desk');
    await assert.rejects(service.create(kiosk, session, docB), (e) => {
      assert.equal(statusOf(e), 409);
      const body = responseOf(e);
      assert.equal(body.code, 'HAS_TOKEN');
      assert.equal(body.token.label, desk.token.label);
      assert.equal(body.token.trackUrl, `https://web.example/track#${desk.token.trackCode}`);
      assert.equal('uhid' in body.token, false);
      return true;
    });
    assert.equal(await m().OpVisit.countDocuments({}), 0);
  });

  test('create is refused for a doctor finished for today', async () => {
    const session = await sessionFor('U1');
    await rejectsWith(service.create(kiosk, session, docDone), 'DOCTOR_NOT_BOOKABLE');
    await m().OpDoctor.updateOne({ _id: docB }, { $set: { active: false } });
    await rejectsWith(service.create(kiosk, session, docB), 'DOCTOR_NOT_BOOKABLE');
    await rejectsWith(service.create(kiosk, 'nonsense', docA), 'SESSION_ENDED');
    assert.equal(await m().OpVisit.countDocuments({}), 0);
  });

  test('UPI order uses the sample payee and the exact fee', async () => {
    const visit = await visitWith('U1', 'UPI');
    assert.equal(visit.sample, true);
    const stored = await m().OpVisit.findById(visit.id).lean();
    assert.match(stored!.orderId!, /^SAMPLE-/);
    const link = new URL(visit.upiUri!);
    assert.equal(link.protocol, 'upi:');
    assert.equal(link.searchParams.get('pa'), 'medios.sample@sample');
    assert.equal(link.searchParams.get('pn'), "St. Mary's Multi Speciality Hospital");
    assert.equal(link.searchParams.get('am'), '300.00');
    assert.equal(link.searchParams.get('tr'), stored!.orderId);
    assert.equal(link.searchParams.get('tn'), 'OP consultation (SAMPLE)');
    assert.equal(link.searchParams.get('cu'), 'INR');
    assert.match(visit.upiUri!, /am=300\.00&/);

    // Choosing again replaces the order.
    const card = await service.pay(kiosk, visit.id, 'CARD');
    assert.equal(card.method, 'CARD');
    assert.equal(card.upiUri, undefined);
    assert.notEqual((await m().OpVisit.findById(visit.id).lean())!.orderId, stored!.orderId);
    const paid = await service.sampleComplete(kiosk, visit.id);
    assert.match(paid.transactionId!, /^SAMPLE-CARD-/);
    // Revenue keeps the kiosk mode; the method, its reference and SAMPLE are in the reference text.
    const [payment] = (await revenueOf(paid.id)).payments;
    assert.equal(payment.mode, 'kiosk');
    assert.equal(payment.reference, `Card · ${paid.transactionId} · SAMPLE`);
  });

  test('a method turned off, or without a payment provider, is refused', async () => {
    await m().HospitalSettings.updateOne({}, { $set: { 'reception.methods.card': false } });
    const visit = await service.create(kiosk, await sessionFor('U1'), docA);
    await rejectsWith(service.pay(kiosk, visit.id, 'CARD'), 'METHOD_OFF');

    const noProvider = build(null);
    const other = await noProvider.create(kiosk, await sessionFor('U2'), docA);
    assert.equal(other.sample, false);
    await rejectsWith(noProvider.pay(kiosk, other.id, 'UPI'), 'METHOD_OFF');
    const cash = await noProvider.pay(kiosk, other.id, 'CASH');
    assert.equal(cash.method, 'CASH');
    await assert.rejects(noProvider.sampleComplete(kiosk, other.id), (e) => statusOf(e) === 400);
  });

  test('OP numbers count up per clinic day', async () => {
    const paid = async (uhid: string) => service.sampleComplete(kiosk, (await visitWith(uhid, 'UPI')).id);
    assert.equal((await paid('U1')).opNumber, 'OP-20260926-0001');
    assert.equal((await paid('U2')).opNumber, 'OP-20260926-0002');
    process.env.CLINIC_DATE = '2026-09-27';
    const nextDay = await paid('U3');
    assert.equal(nextDay.opNumber, 'OP-20260927-0001');
    assert.equal((await revenueOf(nextDay.id)).bill!.day, '2026-09-27');
    assert.equal((await m().OpVisit.findById(nextDay.id).lean())!.date, '2026-09-27');
  });

  test('a patient with cash waiting at the counter cannot start another visit', async () => {
    const cash = await visitWith('U1', 'CASH');
    const session = await sessionFor('U1');
    await assert.rejects(service.create(kiosk, session, docB), (e) => {
      assert.equal(statusOf(e), 409);
      assert.equal(responseOf(e).code, 'CASH_PENDING');
      assert.equal(responseOf(e).message, `You have a payment waiting at the counter (code ${cash.paymentCode}). Please pay there or ask the staff to cancel it.`);
      return true;
    });
    await rejectsWith(service.create(kiosk, session, docDone), 'CASH_PENDING'); // said first, whatever the doctor
    assert.equal((await m().OpVisit.findById(cash.id).lean())!.status, 'awaiting-payment');
    await service.cancel(cash.id, { actor: 'Ravi' });
    assert.equal((await service.create(kiosk, session, docB)).status, 'awaiting-payment');
  });

  test("a new visit replaces the patient's unpaid UPI, card or unchosen visit", async () => {
    const upi = await visitWith('U1', 'UPI');
    const unchosen = await service.create(kiosk, await sessionFor('U1'), docB);
    const upiStored = await m().OpVisit.findById(upi.id).lean();
    assert.equal(upiStored!.status, 'cancelled');
    assert.equal(upiStored!.history[upiStored!.history.length - 1].event, 'Replaced by a new visit');
    const latest = await service.create(kiosk, await sessionFor('U1'), docA);
    assert.equal((await m().OpVisit.findById(unchosen.id).lean())!.status, 'cancelled');
    assert.deepEqual((await m().OpVisit.find({ uhid: 'U1', status: 'awaiting-payment' }).lean()).map((v) => String(v._id)), [latest.id]);
    await rejectsWith(service.sampleComplete(kiosk, upi.id), 'VISIT_CLOSED');

    // A double tap: both requests answer, and one open visit is left.
    const session = await sessionFor('U2');
    const results = await Promise.allSettled([service.create(kiosk, session, docA), service.create(kiosk, session, docA)]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    assert.equal(await m().OpVisit.countDocuments({ uhid: 'U2', status: 'awaiting-payment' }), 1);
  });

  test('staff list shows cash visits waiting, newest first', async () => {
    const first = await visitWith('U1', 'CASH');
    await visitWith('U2', 'UPI');
    const second = await visitWith('U3', 'CASH', docB);
    const waiting = await service.list({ status: 'awaiting-cash' });
    assert.deepEqual(waiting.map((v) => v.id), [second.id, first.id]);
    assert.equal(waiting[0].fee, 450);
    assert.match(waiting[0].paymentCode!, /^\d{4}$/);
    assert.equal((await service.list({})).length, 3);
    assert.deepEqual(await service.list({ date: '2026-09-25' }), []);
  });

  // ---------------------------------------------------------------- the Revenue Agent (R26)

  /** Today's appointment for the patient with the doctor, as Scheduling books it. */
  const appointmentFor = (uhid: string, doctorId: string, doctorName: string, time = '10:30 AM') =>
    m().Appointment.create({ uhid, patientName: `Patient ${uhid}`, age: 30, gender: 'Male', phone: '9876543210', date: '2026-09-26', time, type: 'Consultation', condition: 'Review', status: 'Scheduled', doctorId, doctorName } as any);

  test("a visit that checks in the patient's appointment pays that appointment's own consultation; the check-in hook adds nothing", async () => {
    const appointment = await appointmentFor('U1', docA, 'Dr. A');
    revenueOpd.onModuleInit(); // the async check-in hook, as in the app
    try {
      const visit = await visitWith('U1', 'UPI');
      const paid = await service.sampleComplete(kiosk, visit.id);
      assert.equal(paid.token?.label, 'G-001');
      assert.equal((await m().Appointment.findById(appointment._id).lean())!.status, 'Checked In');
      await new Promise((resolve) => setTimeout(resolve, 100)); // the hook has run by now
      await revenueOpd.onStatusChange({ id: String(appointment._id), status: 'Checked In' }); // and arrives once more

      const all = await m().ChargeLine.find({}).lean();
      assert.deepEqual(all.map((l) => [l.source.type, l.source.ref, l.amount]), [['opd-fee', String(appointment._id), 300]]);
      const { payments, bill } = await revenueOf(visit.id);
      assert.equal(payments.length, 1);
      assert.deepEqual([payments[0].mode, payments[0].amount, payments[0].kind], ['kiosk', 300, 'settlement']);
      assert.equal(payments[0].reference, `UPI · ${paid.transactionId} · SAMPLE`);
      assert.equal(String(payments[0].bill), String(all[0].bill));
      assert.equal(bill!.kind, 'opd');
      assert.equal(String(bill!.appointment), String(appointment._id));
      assert.deepEqual([bill!.totals.charges, bill!.totals.payments, bill!.totals.balance], [300, 300, 0]);
      assert.equal(await m().Bill.countDocuments({}), 1);
      assert.deepEqual([paid.billNumber, paid.receiptNumber], [bill!.number, payments[0].receiptNumber]);
    } finally {
      revenueOpd.onModuleDestroy();
    }
  });

  test("a visit with another doctor than the appointment's leaves the appointment alone and charges the visit's doctor", async () => {
    const appointment = await appointmentFor('U1', docA, 'Dr. A');
    const visit = await visitWith('U1', 'CASH', docB);
    const paid = await service.confirmCash(visit.id, 'Anita');
    assert.equal(paid.token?.label, 'G2-001');
    assert.equal((await m().Appointment.findById(appointment._id).lean())!.status, 'Scheduled');
    assert.equal(await m().ChargeLine.countDocuments({ 'source.type': 'opd-fee' }), 0);
    const { payments, bill, lines } = await revenueOf(visit.id);
    assert.deepEqual(lines.map((l) => [l.name, l.amount, l.source.type, l.source.ref]), [['Consultation - Dr. B', 450, 'op-visit', visit.id]]);
    assert.deepEqual(payments.map((p) => [p.amount, p.reference, p.by.name]), [[450, 'Cash at counter', 'Anita']]);
    assert.equal(bill!.kind, 'walk-in');
    assert.equal(bill!.totals.balance, 0);
  });

  test('a Revenue failure never holds back the token; the payment is recorded on a later try', async () => {
    const warnings: string[] = [];
    (service as unknown as { logger: { warn(message: string): void } }).logger = { warn: (message) => warnings.push(message) };
    const record = revenue.record;
    revenue.record = async () => {
      throw new Error('revenue unavailable');
    };

    const visit = await visitWith('U1', 'UPI');
    const paid = await service.sampleComplete(kiosk, visit.id);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.token?.label, 'G-001');
    assert.equal(paid.billNumber, undefined);
    assert.ok(warnings.some((w) => w.includes('revenue unavailable')));
    assert.equal((await service.getForKiosk(kiosk, visit.id)).token?.label, 'G-001');
    // Shown to the desk until it is recorded, and tried again on each list.
    assert.deepEqual((await service.list({ status: 'needs-attention' })).map((v) => v.id), [visit.id]);
    assert.equal(await m().Payment.countDocuments({}), 0);

    revenue.record = record;
    assert.deepEqual(await service.list({ status: 'needs-attention' }), []);
    const healed = await service.getForKiosk(kiosk, visit.id);
    assert.equal(healed.billNumber, 'BL-0001');
    assert.equal(healed.receiptNumber, 'RC-0001');
    assert.equal((await revenueOf(visit.id)).bill!.totals.balance, 0);
    assert.equal(await m().Payment.countDocuments({}), 1);
    assert.equal(await m().QueueToken.countDocuments({}), 1);
  });

  test('a paid visit that holds an old invoice from before the Revenue Agent is never billed again', async () => {
    for (const [uhid, date] of [['L1', '2026-09-26'], ['L2', '2026-09-25']]) {
      const visit = await visitWith(uhid, 'UPI');
      await m().OpVisit.updateOne(
        { _id: visit.id },
        { $set: { date, status: 'paid', paidAt: clock, confirmedBy: 'Gateway', finishingUntil: clock, opNumber: `OP-${date.replace(/-/g, '')}-0009`, tokenId: '64b000000000000000000001', tokenLabel: 'G-009', billId: '64b000000000000000000002', billNumber: `OPB-${date.replace(/-/g, '')}-0009` } },
      );
    }
    advance(31);
    await service.list({});
    assert.deepEqual(await service.list({ status: 'needs-attention' }), []);
    assert.equal(await m().Payment.countDocuments({}), 0);
    assert.equal(await m().ChargeLine.countDocuments({}), 0);
    assert.equal(await m().Bill.countDocuments({}), 0);
  });

  test("an earlier day's visit that missed only its bill is recorded on that day's bill, with no new token", async () => {
    const visit = await visitWith('U1', 'UPI');
    const tokenId = '64b000000000000000000003';
    const set = { status: 'paid', paidAt: clock, transactionId: 'T-OLD', confirmedBy: 'Gateway', finishingUntil: clock, opNumber: 'OP-20260925-0004', tokenId, tokenLabel: 'G-004' };
    await m().OpVisit.updateOne({ _id: visit.id }, { $set: { ...set, date: '2026-09-25' } });
    // One from longer ago than the retry window is left alone.
    const old = await visitWith('U2', 'UPI');
    await m().OpVisit.updateOne({ _id: old.id }, { $set: { ...set, date: '2026-09-18', opNumber: 'OP-20260918-0001' } });

    await service.list({});
    const { payments, bill } = await revenueOf(visit.id);
    assert.equal(payments.length, 1);
    assert.equal(bill!.day, '2026-09-25');
    assert.equal(bill!.totals.balance, 0);
    assert.equal((await m().OpVisit.findById(visit.id).lean())!.billNumber, bill!.number);
    assert.equal(await m().QueueToken.countDocuments({}), 0);
    assert.equal((await revenueOf(old.id)).payments.length, 0);
  });
});
