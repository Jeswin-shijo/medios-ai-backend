import mongoose, { Model, Schema, Types } from 'mongoose';
import { hourOf } from '../common/utils/series';
import { AppointmentEvents } from '../modules/appointments/appointment-events';
import { Appointment, AppointmentSchema } from '../modules/appointments/schemas/appointment.schema';
import type { Actor } from '../modules/beds/actor';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { Bed, BedSchema } from '../modules/beds/schemas/bed.schema';
import { Ward, WardSchema } from '../modules/beds/schemas/ward.schema';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { ApprovalsService } from '../modules/coordinator/approvals.service';
import { CasesService } from '../modules/coordinator/cases.service';
import { ClocksService } from '../modules/coordinator/clocks.service';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { DEFAULT_TITLES, EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { RulesService } from '../modules/coordinator/rules.service';
import { AgentMessage, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Approval, ApprovalSchema } from '../modules/coordinator/schemas/approval.schema';
import { Case, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { Clock, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { DutyTitle, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Escalation, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Ladder, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { DischargeOrder, DischargeOrderSchema } from '../modules/discharge/schemas/discharge-order.schema';
import { ErVisit, ErVisitSchema } from '../modules/er/schemas/er-visit.schema';
import { LabLine, LabLineSchema } from '../modules/lab/schemas/lab-line.schema';
import { LabRequest, LabRequestSchema } from '../modules/lab/schemas/lab-request.schema';
import { LAB_TESTS } from '../modules/lab/lab-catalogue';
import { OpDoctor, OpDoctorSchema } from '../modules/opd/schemas/op-doctor.schema';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { MEDICINES } from '../modules/pharmacy/pharmacy-catalogue';
import { PharmacyLine, PharmacyLineSchema } from '../modules/pharmacy/schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderSchema } from '../modules/pharmacy/schemas/pharmacy-order.schema';
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
import { RevenueOverviewService } from '../modules/revenue/revenue-overview.service';
import { RevenueAiService } from '../modules/revenue/revenue-ai';
import { PaymentsService } from '../modules/revenue/revenue-payments.service';
import { RefundsService } from '../modules/revenue/revenue-refunds.service';
import { RevenueSettingsService } from '../modules/revenue/revenue-settings.service';
import { Bill, BillSchema } from '../modules/revenue/schemas/bill.schema';
import { ChargeLine, ChargeLineSchema } from '../modules/revenue/schemas/charge-line.schema';
import { Correction, CorrectionSchema } from '../modules/revenue/schemas/correction.schema';
import { Estimate, EstimateSchema } from '../modules/revenue/schemas/estimate.schema';
import { Payment, PaymentSchema } from '../modules/revenue/schemas/payment.schema';
import { PriceItem, PriceItemSchema } from '../modules/revenue/schemas/price-item.schema';
import { Refund, RefundSchema } from '../modules/revenue/schemas/refund.schema';
import { RevenueSnapshot, RevenueSnapshotSchema } from '../modules/revenue/schemas/revenue-snapshot.schema';
import { PROCEDURES } from '../modules/scheduling/scheduling-catalogue';
import { ConsultRequest, ConsultRequestSchema } from '../modules/scheduling/schemas/consult-request.schema';
import { ProcedureBooking, ProcedureBookingSchema } from '../modules/scheduling/schemas/procedure-booking.schema';
import { HospitalSettings, HospitalSettingsSchema } from '../modules/settings/schemas/settings.schema';
import { SettingsService } from '../modules/settings/settings.service';
import { TaskAlertItem, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { TimelineEvent, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { TimelineService } from '../modules/timeline/timeline.service';
import { User, UserRole, UserSchema } from '../modules/users/schemas/user.schema';

// Loosely typed on purpose (see seed.ts).
const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------------------------------------------------------------------------------------------
// The price list: made-up prices typical of a private hospital in Tamil Nadu, whole rupees.
// ---------------------------------------------------------------------------------------------

/** Two codes are left without a price on purpose, so a "needs a price" line can show. */
export const PRICELESS_CODES = ['lab:blood-culture', 'med:heparin-mdv-25000'] as const;

const LAB_PRICES: Record<string, number> = {
  cbc: 350, crp: 450, rft: 600, electrolytes: 500, lft: 700, glucose: 150, hba1c: 550, lipid: 650, coag: 600, troponin: 1200, ddimer: 1100, abg: 900, thyroid: 800, urine: 150,
};

/** The package price of each procedure, imaging included. */
const PROCEDURE_PRICES: Record<string, number> = {
  'coronary-angiography': 18000,
  'coronary-angioplasty': 145000,
  'lap-appendectomy': 65000,
  'hernia-repair': 48000,
  'caesarean-section': 55000,
  'fracture-fixation': 72000,
  'upper-gi-endoscopy': 4500,
  'chest-xray': 400,
  'ct-head': 3500,
  'ct-abdomen-contrast': 4500,
  'ultrasound-abdomen': 1200,
  echocardiogram: 1800,
};

const FORM_PRICE: Record<string, number> = { tab: 6, 'sl-tab': 5, cap: 9, syringe: 420, mdv: 650, ampoule: 40, vial: 300, bag: 90, bottle: 60, nebule: 14, sachet: 20 };
/** Medicines that cost more or less than their form suggests (per issue unit). */
const MEDICINE_PRICES: Record<string, number> = {
  'aspirin-tab-75': 2, 'aspirin-tab-150': 3, 'aspirin-tab-300': 4,
  'ticagrelor-tab-90': 48, 'clopidogrel-tab-75': 9,
  'enoxaparin-syringe-40': 380, 'enoxaparin-syringe-60': 520, 'enoxaparin-syringe-80': 690,
  'insulin-regular-mdv-1000': 180,
  'piperacillin-tazobactam-vial-4.5': 1850, 'meropenem-vial-1': 4500, 'vancomycin-vial-500': 980, 'vancomycin-vial-1000': 1650, 'ceftriaxone-vial-1': 95,
  'hydrocortisone-vial-100': 45, 'adrenaline-ampoule-1': 22, 'morphine-ampoule-10': 38, 'normal-saline-bag-500': 55, 'ringer-lactate-bag-500': 60,
  'paracetamol-tab-500': 2, 'paracetamol-tab-650': 3, 'paracetamol-bottle-1000': 85, 'metformin-tab-500': 3, 'metformin-tab-1000': 5, 'cetirizine-tab-10': 3,
};

/** One price-list row. */
interface Row {
  code: string;
  name: string;
  category: string;
  unit: string;
  price: number;
}

function priceRows(): Row[] {
  const rows: Row[] = [
    { code: 'er:registration', name: 'ER registration', category: 'er', unit: 'each', price: 300 },
    { code: 'er:doctor', name: 'ER doctor', category: 'er', unit: 'each', price: 800 },
    { code: 'consult:stat', name: 'Specialist consult (STAT)', category: 'consultation', unit: 'each', price: 1500 },
    { code: 'consult:urgent', name: 'Specialist consult (urgent)', category: 'consultation', unit: 'each', price: 1000 },
    { code: 'consult:routine', name: 'Specialist consult (routine)', category: 'consultation', unit: 'each', price: 700 },
    { code: 'nursing:general', name: 'Nursing and doctor visit, general ward', category: 'nursing', unit: 'day', price: 800 },
    { code: 'nursing:private', name: 'Nursing and doctor visit, private room', category: 'nursing', unit: 'day', price: 1200 },
    { code: 'nursing:critical', name: 'Nursing and doctor visit, ICU and HDU', category: 'nursing', unit: 'day', price: 3000 },
    { code: 'cons:stent-des', name: 'Drug-eluting stent', category: 'consumables', unit: 'each', price: 38000 },
    { code: 'cons:guide-wire', name: 'Guide wire', category: 'consumables', unit: 'each', price: 3500 },
    { code: 'cons:iv-set', name: 'IV set', category: 'consumables', unit: 'each', price: 150 },
  ];
  for (const t of LAB_TESTS) rows.push({ code: `lab:${t.key}`, name: t.label, category: 'lab', unit: 'test', price: (PRICELESS_CODES as readonly string[]).includes(`lab:${t.key}`) ? 0 : (LAB_PRICES[t.key] ?? 400) });
  for (const medicine of MEDICINES) {
    for (const p of medicine.products) {
      const code = `med:${p.key}`;
      rows.push({ code, name: p.label, category: 'pharmacy', unit: p.issueUnit, price: (PRICELESS_CODES as readonly string[]).includes(code) ? 0 : (MEDICINE_PRICES[p.key] ?? FORM_PRICE[p.form] ?? 25) });
    }
  }
  for (const p of PROCEDURES) {
    rows.push({ code: `proc:${p.key}`, name: p.name, category: p.roomKind === 'xray' || p.roomKind === 'ct' || p.roomKind === 'ultrasound' ? 'imaging' : 'procedure', unit: 'package', price: PROCEDURE_PRICES[p.key] ?? 5000 });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------

/** The services the app wires, built by hand on the seed's models (as the specs do). */
function wire() {
  const registry = new AgentRegistry();
  const events = new CoordinatorEvents();
  const messages = new MessagesService(model(AgentMessage, AgentMessageSchema) as never, registry, events);
  const escalations = new EscalationsService(
    model(Escalation, EscalationSchema) as never, model(DutyTitle, DutyTitleSchema) as never, model(Ladder, LadderSchema) as never,
    model(TaskAlertItem, TaskAlertItemSchema) as never, model(User, UserSchema) as never, messages, events,
  );
  // Starts and stops the clocks the messages below ask for.
  new ClocksService(model(Clock, ClockSchema) as never, registry, messages, escalations);
  const approvals = new ApprovalsService(model(Approval, ApprovalSchema) as never, model(DutyTitle, DutyTitleSchema) as never, registry, messages, events);
  const settingsService = new SettingsService(model(HospitalSettings, HospitalSettingsSchema) as never);
  const settings = new RevenueSettingsService(settingsService);
  const rules = new RulesService(registry, settingsService, events);
  const registration = new RevenueCoordinatorRegistration(registry, model(Bill, BillSchema) as never, model(Refund, RefundSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never, messages);
  const bills = new RevenueBillsService(
    model(Bill, BillSchema) as never, model(ChargeLine, ChargeLineSchema) as never, model(Payment, PaymentSchema) as never, model(Refund, RefundSchema) as never,
    model(Correction, CorrectionSchema) as never, model(Estimate, EstimateSchema) as never, model(CoordinatorCounter, CoordinatorCounterSchema) as never, model(Patient, PatientSchema) as never,
    undefined, model(Admission, AdmissionSchema) as never,
  );
  const prices = new PriceListService(model(PriceItem, PriceItemSchema) as never, model(Ward, WardSchema) as never, model(OpDoctor, OpDoctorSchema) as never);
  const capture = new RevenueCaptureService(
    messages, prices, bills, registration, model(ErVisit, ErVisitSchema) as never, model(LabRequest, LabRequestSchema) as never, model(LabLine, LabLineSchema) as never,
    model(PharmacyLine, PharmacyLineSchema) as never, model(PharmacyOrder, PharmacyOrderSchema) as never, model(ProcedureBooking, ProcedureBookingSchema) as never,
    model(ConsultRequest, ConsultRequestSchema) as never, model(ChargeLine, ChargeLineSchema) as never,
  );
  const final = new FinalBillService(
    messages, registration, settings, bills, model(Bill, BillSchema) as never, model(ChargeLine, ChargeLineSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never,
    model(PharmacyOrder, PharmacyOrderSchema) as never, model(PharmacyLine, PharmacyLineSchema) as never, model(LabRequest, LabRequestSchema) as never, model(LabLine, LabLineSchema) as never,
    model(Admission, AdmissionSchema) as never, model(Appointment, AppointmentSchema) as never, model(DischargeOrder, DischargeOrderSchema) as never,
  );
  const payments = new PaymentsService(registration, settings, bills, final, model(Payment, PaymentSchema) as never);
  const opd = new RevenueOpdService(
    new AppointmentEvents(), prices, bills, model(Appointment, AppointmentSchema) as never, model(Patient, PatientSchema) as never, model(ChargeLine, ChargeLineSchema) as never, final,
  );
  const estimates = new RevenueEstimatesService(
    registration, settings, prices, model(Bill, BillSchema) as never, model(Estimate, EstimateSchema) as never, model(ProcedureBooking, ProcedureBookingSchema) as never,
    model(Admission, AdmissionSchema) as never, model(Bed, BedSchema) as never,
  );
  const deposits = new RevenueDepositsService(
    messages, registration, rules, settings, prices, bills, estimates, model(Bill, BillSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never,
    model(ProcedureBooking, ProcedureBookingSchema) as never, model(Admission, AdmissionSchema) as never, model(Bed, BedSchema) as never, model(Ward, WardSchema) as never, model(Case, CaseSchema) as never,
  );
  const bedDays = new RevenueBedDaysService(
    messages, prices, bills, registration, model(Admission, AdmissionSchema) as never, model(Bed, BedSchema) as never, model(Case, CaseSchema) as never,
    model(Bill, BillSchema) as never, model(ChargeLine, ChargeLineSchema) as never, estimates, deposits, final, settings, model(DischargeOrder, DischargeOrderSchema) as never,
  );
  const refunds = new RefundsService(registration, settings, bills, approvals, final, model(Refund, RefundSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never);
  const corrections = new CorrectionsService(registration, bills, approvals, final, prices, capture, model(Correction, CorrectionSchema) as never, model(ChargeLine, ChargeLineSchema) as never);
  // snapshot() never asks the AI, so the overview has none.
  const overview = new RevenueOverviewService(
    model(RevenueSnapshot, RevenueSnapshotSchema) as never, model(Bill, BillSchema) as never, model(ChargeLine, ChargeLineSchema) as never, model(Payment, PaymentSchema) as never,
    model(Refund, RefundSchema) as never, model(TaskAlertItem, TaskAlertItemSchema) as never, new RevenueAiService(undefined as never),
  );
  // The admitted patients' cases, opened or joined as the Bed Agent does on a bed assignment (F3). No case closes while the
  // seed runs: an empty registry has no close checks (as in seedScheduling).
  const cases = new CasesService(
    model(Case, CaseSchema) as never, model(CoordinatorCounter, CoordinatorCounterSchema) as never, messages, new AgentRegistry(),
    new TimelineService(model(TimelineEvent, TimelineEventSchema) as never),
  );
  registration.onModuleInit();
  return { escalations, registration, bills, prices, capture, final, payments, opd, estimates, deposits, bedDays, refunds, corrections, overview, cases };
}

/**
 * Replaces everything the Revenue agent keeps with a demo: the price list and about 20 bills in every state, built through
 * the live services so the totals, tasks and clocks are real (Mohan Raj's open ER bill with the estimate for his booked
 * angiography, James Wilson's HDU stay with a top-up due, David Raj's final bill waiting with a needs-price line, settled bills
 * with receipts, a refund due, a discount waiting for approval, the clinic day's outpatient fees and a walk-in), plus a week
 * of hourly snapshots. Run last, after seedScheduling: it reads the visits, admissions, tests, medicines and appointments the
 * other seeds made and writes none of them; the one Coordinator write is the admitted patients' cases, opened or joined as a
 * bed assignment does. The Revenue Agent "starts" at this moment (R36), so the reconcile pass never
 * back-bills the rest of the clinic day. Money times use the clinic clock; everything else the real clock, so nothing is after `nowMs`.
 * `nowMs` is for tests, which pin the clock (Date) to it as well: the live services stamp their own records.
 */
export async function seedRevenue(clinicDay: string, nowMs: number = Date.now()): Promise<void> {
  if (Math.abs(Date.now() - nowMs) > 5 * MIN) throw new Error('Revenue seed: nowMs must be the clock now (a test pins Date to it): the live services stamp their records with it.');
  // The services read "today" from CLINIC_DATE, which the seed may run without (it reads .env only when MONGODB_URI is not
  // passed), so the clinic day is pinned while it runs.
  const savedClinic = process.env.CLINIC_DATE;
  process.env.CLINIC_DATE = clinicDay;
  try {
    await run(clinicDay, nowMs);
  } finally {
    if (savedClinic === undefined) delete process.env.CLINIC_DATE;
    else process.env.CLINIC_DATE = savedClinic;
  }
}

async function run(clinicDay: string, nowMs: number): Promise<void> {
  const users = model(User, UserSchema);
  const patientsModel = model(Patient, PatientSchema);
  const appointmentsModel = model(Appointment, AppointmentSchema);
  const visits = model(ErVisit, ErVisitSchema);
  const labRequests = model(LabRequest, LabRequestSchema);
  const labLines = model(LabLine, LabLineSchema);
  const pharmacyOrders = model(PharmacyOrder, PharmacyOrderSchema);
  const pharmacyLines = model(PharmacyLine, PharmacyLineSchema);
  const admissions = model(Admission, AdmissionSchema);
  const bookings = model(ProcedureBooking, ProcedureBookingSchema);
  const messagesModel = model(AgentMessage, AgentMessageSchema);
  const clocks = model(Clock, ClockSchema);
  const escalationsModel = model(Escalation, EscalationSchema);
  const approvalsModel = model(Approval, ApprovalSchema);
  const alerts = model(TaskAlertItem, TaskAlertItemSchema);
  const counters = model(CoordinatorCounter, CoordinatorCounterSchema);
  const titles = model(DutyTitle, DutyTitleSchema);
  const billModel = model(Bill, BillSchema);
  const lineModel = model(ChargeLine, ChargeLineSchema);
  const paymentModel = model(Payment, PaymentSchema);
  const refundModel = model(Refund, RefundSchema);
  const correctionModel = model(Correction, CorrectionSchema);
  const estimateModel = model(Estimate, EstimateSchema);
  const snapshotModel = model(RevenueSnapshot, RevenueSnapshotSchema);
  const priceModel = model(PriceItem, PriceItemSchema);

  // ---- What the seed builds on, checked before anything is wiped ---------------------------------------
  const account = async (email: string): Promise<Actor> => {
    const u = await users.findOne({ email }).select('name role').lean<any>();
    if (!u) throw new Error(`Revenue seed: no user ${email}. Seed the users first.`);
    return { id: String(u._id), name: u.name as string, role: u.role as UserRole };
  };
  const admin = await account('admin@medios.ai');
  const desk = await account('frontdesk@medios.ai');
  const byUhid = async (uhid: string) => {
    const p = await patientsModel.findOne({ uhid }).lean<any>();
    if (!p) throw new Error(`Revenue seed: patient ${uhid} not found. Seed the patients first.`);
    return p;
  };
  const davidRaj = await byUhid('MHK202500325');
  const jamesWilson = await byUhid('MHK202500327');
  const mohanVisit = (await visits.find({ status: { $ne: 'left' } }).lean<any[]>()).find((v) => /Pressure in the chest/.test(v.complaintText ?? ''));
  if (!mohanVisit) throw new Error('Revenue seed: no open ER visit for chest pressure. Run the ER seed first.');
  const admissionOf = async (patient: any) => {
    const a = await admissions.findOne({ patient: patient._id, status: 'active', sample: { $ne: true } }).lean<any>();
    if (!a) throw new Error(`Revenue seed: ${patient.name} has no admission. Run the Bed seed first.`);
    return a;
  };
  const jamesAdmission = await admissionOf(jamesWilson);
  const davidAdmission = await admissionOf(davidRaj);

  // ---- The previous run's data, and nothing else, goes ------------------------------------------------
  const oldClockIds = (await clocks.find({ def: /^revenue-/ }).select('_id').lean<any[]>()).map((c) => String(c._id));
  const oldEscalationIds = (await escalationsModel.find({ $or: [{ ladder: 'revenue' }, { 'source.id': { $in: oldClockIds } }] }).select('_id').lean<any[]>()).map((e) => String(e._id));
  const oldApprovalIds = (await approvalsModel.find({ type: /^revenue\./ }).select('_id').lean<any[]>()).map((a) => String(a._id));
  await Promise.all([
    billModel.deleteMany({}),
    lineModel.deleteMany({}),
    paymentModel.deleteMany({}),
    refundModel.deleteMany({}),
    correctionModel.deleteMany({}),
    estimateModel.deleteMany({}),
    snapshotModel.deleteMany({}),
    priceModel.deleteMany({}),
    messagesModel.deleteMany({
      $or: [
        { from: 'revenue' },
        {
          dedupeKey: {
            $in: [
              ...oldClockIds.map((id) => `clock.expired:${id}`),
              ...oldEscalationIds.map((id) => `escalation.raised:${id}`),
              ...oldApprovalIds.flatMap((id) => [`approval.requested:${id}`, `approval.decided:${id}`]),
            ],
          },
        },
      ],
    }),
    clocks.deleteMany({ def: /^revenue-/ }),
    escalationsModel.deleteMany({ _id: { $in: oldEscalationIds } }),
    approvalsModel.deleteMany({ type: /^revenue\./ }),
    alerts.deleteMany({ $or: [{ link: /^revenue-/ }, { link: { $in: oldEscalationIds.map((id) => `escalation:${id}`) } }] }),
    counters.deleteMany({ key: { $in: ['revenue-bill', 'revenue-receipt', 'revenue-refund', 'revenue-start'] } }),
  ]);
  // The collections were replaced: their indexes (the one source per bill, one open bill per link) must exist before the first write.
  for (const m of [billModel, lineModel, paymentModel, refundModel, correctionModel, estimateModel, snapshotModel, priceModel]) await m.syncIndexes();
  // Billing in charge has no rostered person in this demo, so the admin holds it (seedScheduling does the same; kept here for a database seeded without it).
  const billingTitle = DEFAULT_TITLES.find((t) => t.key === 'billing-in-charge')!;
  await titles.updateOne({ key: 'billing-in-charge' }, { $set: { holders: [new Types.ObjectId(admin.id)] }, $setOnInsert: { key: billingTitle.key, label: billingTitle.label } }, { upsert: true });

  const w = wire();
  await w.escalations.ensureDefaults();
  // The money listeners (deposit met, top-up) run as the bill changes, without being waited for; here the seed calls the same two
  // checks after each change, so every task and clock is in place when the seed moves on.
  w.bills.onTotalsChanged.length = 0;
  const afterMoney = async (billId: string) => {
    await w.deposits.closeIfMet(billId);
    await w.deposits.checkTopUp(billId);
  };

  // ---- Start time (R36): the Revenue Agent starts billing at this reseed -----------------------------------
  await w.bills.startedAt();

  // ---- The price list --------------------------------------------------------------------------------------
  const rows = priceRows();
  for (const r of rows) await w.prices.upsert(admin, r);

  // ---- Small helpers ---------------------------------------------------------------------------------------
  const view = async (billId: string) => (await billModel.findById(billId).lean<any>())!;
  const pay = async (billId: string, amount: number, mode: 'cash' | 'upi' | 'card', kind: 'deposit' | 'part' | 'settlement', reference = '') => {
    const p = await w.payments.record(desk, billId, { amount, mode, kind, ...(reference ? { reference } : {}) });
    await afterMoney(billId);
    return p;
  };
  /** The tests collected and the medicines issued on a case, charged as the capture handlers charge them (lab.collected, pharmacy.issued). */
  const chargeCaseCare = async (caseRef: unknown) => {
    const caseId = String(caseRef);
    for (const request of await labRequests.find({ case: caseRef }).sort({ _id: 1 }).lean<any[]>()) {
      const lines = await labLines.find({ request: request._id, status: { $in: ['collected', 'received', 'awaiting-validation', 'released'] } }).lean<any[]>();
      if (lines.length) await w.capture.replay('lab.collected', { case: caseId, payload: { requestId: String(request._id), tests: lines.map((l) => l.test) } });
    }
    const orderIds = (await pharmacyOrders.find({ case: caseRef }).select('_id').lean<any[]>()).map((o) => o._id);
    for (const line of await pharmacyLines.find({ order: { $in: orderIds }, status: 'issued' }).sort({ _id: 1 }).lean<any[]>()) {
      await w.capture.replay('pharmacy.issued', { case: caseId, payload: { lineId: String(line._id), quantity: line.issued?.quantity ?? 1 } });
    }
  };
  /** The charges the other agents recorded on a visit's case: the ER fees, the collected tests and the issued medicines, as the capture handlers charge them. */
  const chargeCase = async (visit: any) => {
    const caseId = String(visit.case);
    await w.capture.replay('er.arrived', { case: caseId, payload: { visitId: String(visit._id) } });
    if (visit.doctorSeenAt) await w.capture.replay('er.doctor-seen', { case: caseId, payload: { visitId: String(visit._id) } });
    await chargeCaseCare(visit.case);
    return (await billModel.findOne({ kind: 'er', erVisit: visit._id }).lean<any>()) ?? null;
  };
  /**
   * The assignment of a bed: the admission bill, the bed days so far, the estimate and the deposit task. First the patient's
   * case is opened or joined (lifted to ipd) with the admission on it, as the Bed Agent does on bed.assigned, so the bill, its
   * messages and its clocks carry the case from the start (a clock is matched on its case and could not be stopped otherwise).
   * Then the care already on the case (collected tests, issued medicines) is charged, as the capture handlers would have done
   * (B3-I1), before any deposit or final-bill maths reads the totals.
   */
  const admit = async (admission: any) => {
    const { case: c } = await w.cases.openOrJoin({
      patientId: String(admission.patient),
      patientUhid: admission.patientUhid,
      patientName: admission.patientName,
      kind: 'ipd',
      priority: 'medium',
      openedBy: 'bed',
    });
    await w.cases.addRefs(String(c._id), { admissionId: String(admission._id) });
    await (w.bedDays as any).onAssigned({ case: String(c._id), payload: { admissionId: String(admission._id) } });
    await chargeCaseCare(c._id);
    const bill = await billModel.findOne({ kind: 'admission', admission: admission._id }).lean<any>();
    if (!bill) throw new Error(`Revenue seed: no admission bill for ${admission.patientName}`);
    return bill;
  };

  // ---- Mohan Raj: the open ER bill, and the estimate for the angiography booked for him ---------------------
  const mohanBill = await chargeCase(mohanVisit);
  if (!mohanBill) throw new Error('Revenue seed: Mohan Raj has no ER bill.');
  await w.estimates.draft(String(mohanBill._id));
  // No deposit task: this is an emergency bill (A1). raise() asks nothing and returns null.
  await w.deposits.raise(String(mohanBill._id));

  // ---- James Wilson: an HDU stay, the advance paid, and a top-up due -----------------------------------------
  const jamesBill = await admit(jamesAdmission);
  const jamesDue = await w.deposits.dueFor((await billModel.findById(jamesBill._id))!);
  if (jamesDue) await pay(String(jamesBill._id), jamesDue.amount, 'upi', 'deposit', 'UPI-DEMO-0001');
  // Care he has had on the ward that no agent captured by itself: the desk adds it, with a reason.
  const paidNow = (await view(String(jamesBill._id))).totals.payments;
  const target = Math.ceil(paidNow * 0.85);
  const stayCharges = (await view(String(jamesBill._id))).totals.charges;
  if (stayCharges < target) {
    const gap = target - stayCharges;
    const oxygen = Math.round((gap * 0.35) / 100) * 100;
    await w.corrections.addMissed(desk, String(jamesBill._id), { code: 'other:oxygen-therapy', name: 'Oxygen therapy', category: 'other', qty: 1, unitPrice: oxygen, reason: 'Given on the ward, not recorded by an agent' });
    await w.corrections.addMissed(desk, String(jamesBill._id), { code: 'other:cardiac-monitoring', name: 'Continuous cardiac monitoring', category: 'other', qty: 1, unitPrice: gap - oxygen, reason: 'HDU monitoring, not recorded by an agent' });
  }
  await afterMoney(String(jamesBill._id));

  // ---- David Raj: the stay is over for billing, the final bill waits, and one line has no price -------------------
  const davidBill = await admit(davidAdmission);
  const davidDue = await w.deposits.dueFor((await billModel.findById(davidBill._id))!);
  if (davidDue) await pay(String(davidBill._id), davidDue.amount, 'cash', 'deposit');
  const unpriced = await w.prices.priceFor(PRICELESS_CODES[0]);
  await w.bills.addCharge(String(davidBill._id), {
    code: PRICELESS_CODES[0],
    name: unpriced.name === PRICELESS_CODES[0] ? 'Blood culture' : unpriced.name,
    category: 'lab',
    qty: 1,
    unitPrice: unpriced.price,
    needsPrice: unpriced.needsPrice,
    source: { type: 'manual', ref: String(new Types.ObjectId()) },
    reason: 'Sent to an outside lab; the price is not in the list yet',
    by: { id: desk.id, name: desk.name },
  });
  await afterMoney(String(davidBill._id));
  await w.final.request('agent', String(davidBill._id));

  // ---- ER visits that ended: settled bills, one with a refund due, one with a discount waiting -----------------
  const left = (await visits.find({ status: 'left', disposition: { $exists: true } }).sort({ leftAt: -1, _id: 1 }).lean<any[]>()).filter((v) => v.disposition?.kind === 'home');
  const usable: any[] = [];
  // Five ended visits get a bill (3 settled, a refund, a discount); the other visits are left to the Revenue Agent's start time.
  for (const v of left) {
    if (usable.length >= 5) break;
    if (String(v.patient) === String(mohanVisit.patient)) continue;
    const bill = await chargeCase(v);
    if (!bill) continue;
    usable.push({ visit: v, billId: String(bill._id) });
  }
  const modes = ['cash', 'upi', 'card'] as const;
  const settledOnes = usable.slice(0, 3);
  for (const [i, u] of settledOnes.entries()) {
    await w.final.request('agent', u.billId);
    await w.final.prepare(desk, u.billId);
    const b = await view(u.billId);
    await pay(u.billId, b.totals.balance, modes[i % 3], 'settlement', i === 1 ? 'UPI-DEMO-0002' : '');
    await w.final.settle(desk, u.billId);
  }
  const refundOne = usable[3];
  if (refundOne) {
    await w.final.request('agent', refundOne.billId);
    const b0 = await view(refundOne.billId);
    // The advance taken at the door was more than the bill came to.
    await pay(refundOne.billId, Math.ceil((b0.totals.balance + 1500) / 500) * 500, 'cash', 'deposit');
    await w.final.prepare(desk, refundOne.billId);
    await w.refunds.request(admin, refundOne.billId);
  }
  const discountOne = usable[4];
  if (discountOne) {
    await w.final.request('agent', discountOne.billId);
    await w.final.prepare(desk, discountOne.billId);
    await w.corrections.request(desk, { billId: discountOne.billId, kind: 'discount', percent: 10, reason: 'Hospital staff relative' });
  }

  // ---- The clinic day's outpatients: the fee of each checked-in appointment; two paid and settled -------------------
  await w.opd.catchUp(clinicDay);
  // Completed visits first (their paid bill settles, R18); earlier in the day there may be none, so a checked-in one is paid instead.
  const feeAppointments = await appointmentsModel.find({ date: clinicDay, status: { $in: ['Completed', 'Checked In', 'Waiting', 'In Consultation'] } }).sort({ time: 1, _id: 1 }).lean<any[]>();
  feeAppointments.sort((a, b) => Number(b.status === 'Completed') - Number(a.status === 'Completed'));
  let paidOpd = 0;
  for (const a of feeAppointments) {
    if (paidOpd >= 2) break;
    const bill = await billModel.findOne({ kind: 'opd', appointment: a._id, state: 'open' }).lean<any>();
    if (!bill || bill.totals.balance < 1) continue;
    if (await lineModel.exists({ bill: bill._id, needsPrice: true })) continue;
    await pay(String(bill._id), bill.totals.balance, modes[paidOpd % 3], 'settlement');
    paidOpd++;
  }

  // ---- A walk-in: medicines bought at the counter, unpaid ---------------------------------------------------------
  const taken = new Set((await billModel.find().select('patient').lean<any[]>()).map((b) => String(b.patient)));
  const openErPatients = new Set((await visits.find({ status: { $ne: 'left' } }).select('patient').lean<any[]>()).map((v) => String(v.patient)));
  // No planned procedure either: a counter sale carries no advance.
  const booked = new Set((await bookings.find({ status: { $nin: ['cancelled', 'done'] } }).select('patient').lean<any[]>()).map((b) => String(b.patient)));
  const walkInPatient = (await patientsModel.find({ detailsPending: { $ne: true } }).sort({ uhid: 1 }).lean<any[]>()).find((p) => !taken.has(String(p._id)) && !openErPatients.has(String(p._id)) && !booked.has(String(p._id)));
  if (walkInPatient) {
    const bill = await w.bills.open({ kind: 'walk-in', patientId: String(walkInPatient._id), day: clinicDay });
    await w.corrections.addMissed(desk, String(bill._id), { code: 'med:paracetamol-tab-500', category: 'pharmacy', qty: 10, reason: 'Counter sale' });
    await w.corrections.addMissed(desk, String(bill._id), { code: 'med:cetirizine-tab-10', category: 'pharmacy', qty: 5, reason: 'Counter sale' });
  }

  // ---- Planned procedures: a bill opened after the booking still gets its estimate and advance, as the booking message would have given it ----
  for (const b of await billModel.find({ state: { $in: ['open', 'final'] } }).sort({ _id: 1 }).lean<any[]>()) {
    if (!(await w.deposits.dueFor((await billModel.findById(b._id))!))) continue;
    await w.estimates.draft(String(b._id));
    await w.deposits.raise(String(b._id));
  }

  // ---- A week of hourly readings; the live one is this hour's ---------------------------------------------------------
  await snapshotModel.insertMany(history(nowMs));
  await w.overview.snapshot();

  const bills = await billModel.find().lean<any[]>();
  const byState = (s: string) => bills.filter((b) => b.state === s).length;
  console.log(
    `✅ Revenue: ${rows.length} prices (${PRICELESS_CODES.length} without a price), ${bills.length} bills (${byState('open')} open, ${byState('final')} final, ${byState('settled')} settled), ` +
      `${await paymentModel.countDocuments()} payments, ${await refundModel.countDocuments()} refund, ${await correctionModel.countDocuments()} correction waiting, ${(await snapshotModel.countDocuments())} snapshots`,
  );
}

/** The card values at every hour of the last week but this one (the live snapshot adds this hour). */
function history(nowMs: number): Record<string, any>[] {
  const lastHour = hourOf(new Date(nowMs)).getTime();
  const busyAt = (h: number) => Math.max(0, Math.sin(((h - 7) / 14) * Math.PI));
  let seed = 3112026;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 167 }, (_, k) => {
    const at = new Date(lastHour - (167 - k) * HOUR);
    const h = at.getHours();
    const dayShare = h < 8 ? 0 : Math.min(1, (h - 7) / 13);
    return {
      at,
      collected: Math.round((52000 + rng() * 14000) * dayShare / 100) * 100,
      openBills: Math.max(3, Math.round(8 + 6 * busyAt(h) + (rng() - 0.5) * 3)),
      depositsDue: Math.max(0, Math.round(busyAt(h) * 2 + (rng() - 0.6))),
      finalWaiting: Math.max(0, Math.round(busyAt(h) * 2 + (rng() - 0.5))),
      refundsDue: Math.max(0, Math.round(rng() * 1.4 - 0.2)),
    };
  });
}
