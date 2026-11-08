import mongoose, { Model, Schema, Types } from 'mongoose';
import { clinicNow, isoDate, parseIsoDay } from '../common/utils/clinic-time';
import { hourOf } from '../common/utils/series';
import { AiService } from '../modules/ai/ai.service';
import { NoAiProvider } from '../modules/ai/ai-provider';
import { AppointmentEvents } from '../modules/appointments/appointment-events';
import { Appointment, AppointmentSchema } from '../modules/appointments/schemas/appointment.schema';
import { AGENT_ACTOR, type Actor } from '../modules/beds/actor';
import { BedEvents } from '../modules/beds/bed-events';
import type { RoomClass } from '../modules/beds/bed-types';
import { BedsService } from '../modules/beds/beds.service';
import { Admission, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { Bed, BedSchema } from '../modules/beds/schemas/bed.schema';
import { Ward, WardSchema } from '../modules/beds/schemas/ward.schema';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { CasesService } from '../modules/coordinator/cases.service';
import { ClocksService } from '../modules/coordinator/clocks.service';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { DEFAULT_TITLES, EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { RulesService } from '../modules/coordinator/rules.service';
import { AgentMessage, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Case, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { Clock, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { CoordinatorCounter, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { DutyTitle, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Escalation, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Ladder, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { DischargeAiService } from '../modules/discharge/discharge-ai';
import { SUMMARY_TITLE } from '../modules/discharge/discharge-catalogue';
import { DischargeRegistration } from '../modules/discharge/discharge-coordinator.registration';
import { DischargeLeavingService } from '../modules/discharge/discharge-leaving.service';
import { DischargeLinesService } from '../modules/discharge/discharge-lines.service';
import { DischargeOrdersService, OrderInput } from '../modules/discharge/discharge-orders.service';
import { DischargeOverviewService } from '../modules/discharge/discharge-overview.service';
import { DischargePlansService } from '../modules/discharge/discharge-plans.service';
import { DischargeSettingsService } from '../modules/discharge/discharge-settings.service';
import { DischargeSummaryService } from '../modules/discharge/discharge-summary.service';
import { DISCHARGE_START } from '../modules/discharge/discharge.scheduler';
import { DischargeOrder, DischargeOrderSchema, takeHomeOrderIds } from '../modules/discharge/schemas/discharge-order.schema';
import { DischargePlan, DischargePlanSchema } from '../modules/discharge/schemas/discharge-plan.schema';
import { DischargeSnapshot, DischargeSnapshotSchema } from '../modules/discharge/schemas/discharge-snapshot.schema';
import { DischargeSummary, DischargeSummarySchema } from '../modules/discharge/schemas/discharge-summary.schema';
import { DocumentsService } from '../modules/documents/documents.service';
import { ClinicalDocument, ClinicalDocumentSchema } from '../modules/documents/schemas/document.schema';
import { ErVisit, ErVisitSchema } from '../modules/er/schemas/er-visit.schema';
import { FollowUpItem, FollowUpItemSchema } from '../modules/follow-ups/schemas/follow-up.schema';
import { LabTestReport, LabTestReportSchema } from '../modules/lab-reports/schemas/lab-report.schema';
import { LabLine, LabLineSchema } from '../modules/lab/schemas/lab-line.schema';
import { LabRequest, LabRequestSchema } from '../modules/lab/schemas/lab-request.schema';
import { OpdService } from '../modules/opd/opd.service';
import { Department, DepartmentSchema } from '../modules/opd/schemas/department.schema';
import { OpDoctor, OpDoctorSchema } from '../modules/opd/schemas/op-doctor.schema';
import { PatientsService } from '../modules/patients/patients.service';
import { Patient, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { PharmacyChecksService } from '../modules/pharmacy/pharmacy-checks.service';
import { PharmacyCoordinatorRegistration } from '../modules/pharmacy/pharmacy-coordinator.registration';
import { PharmacyIssueService } from '../modules/pharmacy/pharmacy-issue.service';
import { LineInput, PharmacyOrdersService } from '../modules/pharmacy/pharmacy-orders.service';
import { PharmacyPatientsService } from '../modules/pharmacy/pharmacy-patients.service';
import { PharmacyProceduresService } from '../modules/pharmacy/pharmacy-procedures.service';
import { PharmacySettingsService } from '../modules/pharmacy/pharmacy-settings.service';
import { PharmacyStockService } from '../modules/pharmacy/pharmacy-stock.service';
import { PharmacyTakeHomeService } from '../modules/pharmacy/pharmacy-take-home.service';
import { PharmacyBatch, PharmacyBatchSchema } from '../modules/pharmacy/schemas/pharmacy-batch.schema';
import { PharmacyLine, PharmacyLineSchema } from '../modules/pharmacy/schemas/pharmacy-line.schema';
import { PharmacyLocation, PharmacyLocationSchema } from '../modules/pharmacy/schemas/pharmacy-location.schema';
import { PharmacyMovement, PharmacyMovementSchema } from '../modules/pharmacy/schemas/pharmacy-movement.schema';
import { PharmacyOrder, PharmacyOrderSchema } from '../modules/pharmacy/schemas/pharmacy-order.schema';
import { PharmacyProcedureNote, PharmacyProcedureNoteSchema } from '../modules/pharmacy/schemas/pharmacy-procedure-note.schema';
import { PharmacyStockLevel, PharmacyStockLevelSchema } from '../modules/pharmacy/schemas/pharmacy-stock-level.schema';
import { PriceListService } from '../modules/revenue/price-list.service';
import { RevenueBedDaysService } from '../modules/revenue/revenue-bed-days.service';
import { RevenueBillsService } from '../modules/revenue/revenue-bills.service';
import { RevenueCaptureService } from '../modules/revenue/revenue-capture.service';
import { RevenueCoordinatorRegistration } from '../modules/revenue/revenue-coordinator.registration';
import { RevenueDepositsService } from '../modules/revenue/revenue-deposits.service';
import { RevenueEstimatesService } from '../modules/revenue/revenue-estimates.service';
import { FinalBillService } from '../modules/revenue/revenue-final.service';
import { PaymentsService } from '../modules/revenue/revenue-payments.service';
import { RevenueSettingsService } from '../modules/revenue/revenue-settings.service';
import { Bill, BillSchema } from '../modules/revenue/schemas/bill.schema';
import { ChargeLine, ChargeLineSchema } from '../modules/revenue/schemas/charge-line.schema';
import { Correction, CorrectionSchema } from '../modules/revenue/schemas/correction.schema';
import { Estimate, EstimateSchema } from '../modules/revenue/schemas/estimate.schema';
import { Payment, PaymentSchema } from '../modules/revenue/schemas/payment.schema';
import { PriceItem, PriceItemSchema } from '../modules/revenue/schemas/price-item.schema';
import { Refund, RefundSchema } from '../modules/revenue/schemas/refund.schema';
import { SchedulingAppointmentsService } from '../modules/scheduling/scheduling-appointments.service';
import { SCHEDULING_MESSAGE_TYPES } from '../modules/scheduling/scheduling-coordinator.registration';
import { SchedulingDoctorsService } from '../modules/scheduling/scheduling-doctors.service';
import { SchedulingFollowupsService } from '../modules/scheduling/scheduling-followups.service';
import { SchedulingWaitlistService } from '../modules/scheduling/scheduling-waitlist.service';
import { ConsultRequest, ConsultRequestSchema } from '../modules/scheduling/schemas/consult-request.schema';
import { DoctorProfile, DoctorProfileSchema } from '../modules/scheduling/schemas/doctor-profile.schema';
import { ProcedureBooking, ProcedureBookingSchema } from '../modules/scheduling/schemas/procedure-booking.schema';
import { WaitItem, WaitItemSchema } from '../modules/scheduling/schemas/wait-item.schema';
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
/** The earliest story moment, in minutes before now: the over-target stay's order. Earlier in the clinic day than this, every story moment is drawn closer to now. */
const STORY_SPAN_MIN = 335;
/** Made-up patients, made only when the hospital has too few free ones; a reseed removes them. */
export const DISCHARGE_MARK = 'Seed: discharge demo';
/** Patients of the other agents' stories, never used here even when free. */
const OTHER_STORIES = /^(mohan raj|james wilson|david raj|jeswin shijo|ssss)$/i;
const DAVID_UHID = 'MHK202500325';

/** The models the seed reads and writes (one registration each, shared with the other seeds). */
function models() {
  return {
    User: model(User, UserSchema),
    Patient: model(Patient, PatientSchema),
    Appointment: model(Appointment, AppointmentSchema),
    Admission: model(Admission, AdmissionSchema),
    Bed: model(Bed, BedSchema),
    Ward: model(Ward, WardSchema),
    ErVisit: model(ErVisit, ErVisitSchema),
    AgentMessage: model(AgentMessage, AgentMessageSchema),
    Case: model(Case, CaseSchema),
    Clock: model(Clock, ClockSchema),
    CoordinatorCounter: model(CoordinatorCounter, CoordinatorCounterSchema),
    DutyTitle: model(DutyTitle, DutyTitleSchema),
    Escalation: model(Escalation, EscalationSchema),
    Ladder: model(Ladder, LadderSchema),
    TaskAlertItem: model(TaskAlertItem, TaskAlertItemSchema),
    TimelineEvent: model(TimelineEvent, TimelineEventSchema),
    HospitalSettings: model(HospitalSettings, HospitalSettingsSchema),
    ClinicalDocument: model(ClinicalDocument, ClinicalDocumentSchema),
    FollowUpItem: model(FollowUpItem, FollowUpItemSchema),
    LabRequest: model(LabRequest, LabRequestSchema),
    LabLine: model(LabLine, LabLineSchema),
    LabTestReport: model(LabTestReport, LabTestReportSchema),
    Department: model(Department, DepartmentSchema),
    OpDoctor: model(OpDoctor, OpDoctorSchema),
    DoctorProfile: model(DoctorProfile, DoctorProfileSchema),
    WaitItem: model(WaitItem, WaitItemSchema),
    ProcedureBooking: model(ProcedureBooking, ProcedureBookingSchema),
    ConsultRequest: model(ConsultRequest, ConsultRequestSchema),
    PharmacyOrder: model(PharmacyOrder, PharmacyOrderSchema),
    PharmacyLine: model(PharmacyLine, PharmacyLineSchema),
    PharmacyLocation: model(PharmacyLocation, PharmacyLocationSchema),
    PharmacyBatch: model(PharmacyBatch, PharmacyBatchSchema),
    PharmacyMovement: model(PharmacyMovement, PharmacyMovementSchema),
    PharmacyStockLevel: model(PharmacyStockLevel, PharmacyStockLevelSchema),
    PharmacyProcedureNote: model(PharmacyProcedureNote, PharmacyProcedureNoteSchema),
    Bill: model(Bill, BillSchema),
    ChargeLine: model(ChargeLine, ChargeLineSchema),
    Payment: model(Payment, PaymentSchema),
    Refund: model(Refund, RefundSchema),
    Correction: model(Correction, CorrectionSchema),
    Estimate: model(Estimate, EstimateSchema),
    PriceItem: model(PriceItem, PriceItemSchema),
    DischargePlan: model(DischargePlan, DischargePlanSchema),
    DischargeOrder: model(DischargeOrder, DischargeOrderSchema),
    DischargeSummary: model(DischargeSummary, DischargeSummarySchema),
    DischargeSnapshot: model(DischargeSnapshot, DischargeSnapshotSchema),
  };
}

/**
 * The live services, built by hand on the seed's models (as the specs do), on one registry that holds the agents whose
 * messages the stories send: Discharge, Revenue (its capture charges issued medicines and asks for the final bill when a
 * window opens), Pharmacy (its clocks, and its cancels on discharge.completed) and Scheduling's message types (a booked
 * follow-up). No case closes while the seed runs: the cases service has an empty registry, so no close checks (as in
 * seedRevenue). Exported for the spec, which reads the seeded stays through the same services.
 */
export function wire() {
  const M = models();
  const registry = new AgentRegistry();
  const events = new CoordinatorEvents();
  const messages = new MessagesService(M.AgentMessage as never, registry, events);
  const escalations = new EscalationsService(
    M.Escalation as never, M.DutyTitle as never, M.Ladder as never, M.TaskAlertItem as never, M.User as never, messages, events,
  );
  // Starts and stops the clocks the messages below ask for.
  new ClocksService(M.Clock as never, registry, messages, escalations);
  const settingsService = new SettingsService(M.HospitalSettings as never);
  const rules = new RulesService(registry, settingsService, events);
  const timeline = new TimelineService(M.TimelineEvent as never);
  const cases = new CasesService(M.Case as never, M.CoordinatorCounter as never, messages, new AgentRegistry(), timeline);
  const patients = new PatientsService(M.Patient as never);
  const beds = new BedsService(M.Ward as never, M.Bed as never, M.Admission as never, patients, new BedEvents(), M.DischargeOrder as never);

  // Revenue: the bills, bed days, deposits, the final bill and payments (as seedRevenue wires them).
  const revenueSettings = new RevenueSettingsService(settingsService);
  const revenue = new RevenueCoordinatorRegistration(registry, M.Bill as never, M.Refund as never, M.TaskAlertItem as never, messages);
  const bills = new RevenueBillsService(
    M.Bill as never, M.ChargeLine as never, M.Payment as never, M.Refund as never, M.Correction as never, M.Estimate as never,
    M.CoordinatorCounter as never, M.Patient as never, undefined, M.Admission as never,
  );
  const prices = new PriceListService(M.PriceItem as never, M.Ward as never, M.OpDoctor as never);
  new RevenueCaptureService(
    messages, prices, bills, revenue, M.ErVisit as never, M.LabRequest as never, M.LabLine as never, M.PharmacyLine as never, M.PharmacyOrder as never,
    M.ProcedureBooking as never, M.ConsultRequest as never, M.ChargeLine as never,
  );
  const final = new FinalBillService(
    messages, revenue, revenueSettings, bills, M.Bill as never, M.ChargeLine as never, M.TaskAlertItem as never, M.PharmacyOrder as never,
    M.PharmacyLine as never, M.LabRequest as never, M.LabLine as never, M.Admission as never, M.Appointment as never, M.DischargeOrder as never,
  );
  const payments = new PaymentsService(revenue, revenueSettings, bills, final, M.Payment as never);
  const estimates = new RevenueEstimatesService(
    revenue, revenueSettings, prices, M.Bill as never, M.Estimate as never, M.ProcedureBooking as never, M.Admission as never, M.Bed as never,
  );
  const deposits = new RevenueDepositsService(
    messages, revenue, rules, revenueSettings, prices, bills, estimates, M.Bill as never, M.TaskAlertItem as never, M.ProcedureBooking as never,
    M.Admission as never, M.Bed as never, M.Ward as never, M.Case as never,
  );
  const bedDays = new RevenueBedDaysService(
    messages, prices, bills, revenue, M.Admission as never, M.Bed as never, M.Case as never, M.Bill as never, M.ChargeLine as never, estimates,
    deposits, final, revenueSettings, M.DischargeOrder as never,
  );
  revenue.onModuleInit();

  // Pharmacy: orders, checks, issues from stock, and the take-home door the Discharge Agent uses.
  const pharmacySettings = new PharmacySettingsService(settingsService);
  const facts = new PharmacyPatientsService(M.Patient as never, M.LabTestReport as never, M.PharmacyProcedureNote as never);
  const pharmacyOrders = new PharmacyOrdersService(
    M.PharmacyOrder as never, M.PharmacyLine as never, M.PharmacyLocation as never, M.CoordinatorCounter as never, patients, cases, messages, pharmacySettings, facts,
  );
  const checks = new PharmacyChecksService(M.PharmacyLine as never, M.PharmacyOrder as never, M.TaskAlertItem as never, pharmacyOrders, cases, messages, pharmacySettings);
  new PharmacyCoordinatorRegistration(
    registry, pharmacyOrders, messages, checks, M.PharmacyOrder as never, M.PharmacyLine as never, M.Clock as never,
    new PharmacyProceduresService(M.PharmacyProcedureNote as never, M.PharmacyLine as never, M.PharmacyOrder as never, M.TaskAlertItem as never, pharmacyOrders, cases, messages, facts),
  ).onModuleInit();
  const stock = new PharmacyStockService(
    M.PharmacyBatch as never, M.PharmacyMovement as never, M.PharmacyStockLevel as never, M.PharmacyLine as never, M.PharmacyOrder as never,
    M.TaskAlertItem as never, pharmacyOrders, pharmacySettings,
  );
  const issue = new PharmacyIssueService(M.PharmacyBatch as never, M.PharmacyMovement as never, M.PharmacyLine as never, M.PharmacyOrder as never, stock, pharmacyOrders, checks);
  const takeHome = new PharmacyTakeHomeService(pharmacyOrders, checks, M.PharmacyOrder as never, M.PharmacyLine as never);

  // Scheduling: the follow-up booking. Its message types are registered as the Discharge specs register them.
  registry.register({ key: 'scheduling', messageTypes: SCHEDULING_MESSAGE_TYPES, status: async () => ({ open: 0, capacity: 0, onTimePct: null }) });
  const opd = new OpdService(M.Department as never, M.OpDoctor as never, settingsService);
  const doctors = new SchedulingDoctorsService(M.DoctorProfile as never, M.Appointment as never, opd);
  const appointments = new SchedulingAppointmentsService(M.Appointment as never, M.Patient as never, doctors, opd, new AppointmentEvents());
  // A follow-up waitlists as an appointment item only; procedures are never touched.
  const waitlist = new SchedulingWaitlistService(
    M.WaitItem as never, M.Appointment as never, M.Patient as never, M.FollowUpItem as never, M.TaskAlertItem as never, doctors, appointments, undefined as never,
  );
  const followUps = new SchedulingFollowupsService(M.Patient as never, M.FollowUpItem as never, M.Case as never, opd, doctors, appointments, waitlist, messages);

  // Discharge. The AI is off here: the course paragraph is the rules' template (never a canned sample presented as AI).
  const dischargeSettings = new DischargeSettingsService(settingsService);
  const registration = new DischargeRegistration(registry, messages, cases, dischargeSettings, M.DischargePlan as never, M.DischargeOrder as never, M.Admission as never);
  registration.onModuleInit();
  const plans = new DischargePlansService(
    registration, messages, rules, dischargeSettings, M.DischargePlan as never, M.Admission as never, M.Bed as never, M.Ward as never, M.Case as never,
    M.TaskAlertItem as never, M.Patient as never,
  );
  const lines = new DischargeLinesService(
    registration, messages, cases, M.DischargeOrder as never, M.DischargePlan as never, M.DischargeSummary as never, M.LabRequest as never, M.LabLine as never,
    M.PharmacyLine as never, M.FollowUpItem as never, M.Bill as never, M.ChargeLine as never, beds,
  );
  const ai = new DischargeAiService(new AiService(new NoAiProvider(), settingsService, undefined as never));
  const summary = new DischargeSummaryService(
    registration, lines, dischargeSettings, cases, ai, new DocumentsService(M.ClinicalDocument as never), timeline, M.DischargeSummary as never,
    M.DischargeOrder as never, M.DischargePlan as never, M.Admission as never, M.Bed as never, M.Ward as never, M.Patient as never, M.LabRequest as never,
    M.LabLine as never, M.PharmacyOrder as never, M.PharmacyLine as never, M.FollowUpItem as never, M.ProcedureBooking as never,
  );
  const orders = new DischargeOrdersService(
    registration, plans, dischargeSettings, cases, beds, takeHome, followUps, lines, summary, M.DischargePlan as never, M.DischargeOrder as never,
    M.DischargeSummary as never, M.PharmacyLine as never,
  );
  const leaving = new DischargeLeavingService(
    registration, plans, orders, lines, dischargeSettings, beds, escalations, M.DischargePlan as never, M.DischargeOrder as never, M.Admission as never,
    M.Bed as never, M.Bill as never, M.CoordinatorCounter as never, messages,
  );
  const overview = new DischargeOverviewService(
    dischargeSettings, cases, ai, M.DischargePlan as never, M.DischargeOrder as never, M.DischargeSummary as never, M.DischargeSnapshot as never,
    M.LabRequest as never, M.LabLine as never,
  );
  return {
    registry, messages, escalations, cases, patients, beds, bills, final, payments, deposits, bedDays, checks, issue, takeHome,
    dischargeSettings, registration, plans, lines, summary, orders, leaving, overview,
  };
}

type World = ReturnType<typeof wire>;

/** One stay of the demo: where, since when, for how long, and whose. */
interface Stay {
  ward: 'GWA' | 'GWB' | 'PVT';
  daysAgo: number;
  stayDays: number;
  department: string;
  doctor: string;
  notes: string;
}

/**
 * The stays besides David Raj's. General ward A is for men and B for women; the private rooms take either. The stays
 * still in progress are short enough that their bed days stay under 80% of the advance (no top-up is due as they
 * leave); the stays that end today are long enough that the final bill is more than the advance.
 */
const STAYS = {
  dueToday: { ward: 'GWA', daysAgo: 3, stayDays: 3, department: 'General Medicine', doctor: 'Dr. Shajin', notes: 'Viral fever with dehydration; on IV fluids' },
  dueTomorrow: { ward: 'GWB', daysAgo: 2, stayDays: 3, department: 'General Medicine', doctor: 'Dr. Shajin', notes: 'Urinary tract infection; on IV antibiotics' },
  overdue: { ward: 'PVT', daysAgo: 3, stayDays: 2, department: 'General Surgery', doctor: 'Dr. Vinod Kumar', notes: 'Laparoscopic cholecystectomy; slow to mobilise' },
  noSummary: { ward: 'GWB', daysAgo: 3, stayDays: 3, department: 'General Medicine', doctor: 'Dr. Shajin', notes: 'Community-acquired pneumonia' },
  noTakeHome: { ward: 'GWA', daysAgo: 3, stayDays: 3, department: 'Orthopaedics', doctor: 'Dr. John Varghese', notes: 'Closed fracture of the left wrist; plaster applied' },
  transfer: { ward: 'PVT', daysAgo: 2, stayDays: 6, department: 'General Medicine', doctor: 'Dr. Shajin', notes: 'Sudden right-sided weakness; CT shows a bleed' },
  ready: { ward: 'GWB', daysAgo: 7, stayDays: 7, department: 'General Medicine', doctor: 'Dr. Shajin', notes: 'Dengue fever; platelets recovering' },
  againstAdvice: { ward: 'GWA', daysAgo: 7, stayDays: 10, department: 'General Medicine', doctor: 'Dr. Shajin', notes: 'Alcoholic liver disease with ascites' },
  onTime: { ward: 'GWB', daysAgo: 7, stayDays: 7, department: 'General Surgery', doctor: 'Dr. Vinod Kumar', notes: 'Open appendectomy; wound healing' },
  overTarget: { ward: 'GWA', daysAgo: 8, stayDays: 8, department: 'General Medicine', doctor: 'Dr. Shajin', notes: 'Uncontrolled diabetes; insulin started' },
} satisfies Record<string, Stay>;
type StayKey = keyof typeof STAYS;

/** Made-up patients for a hospital with too few free ones. */
const SPARE_PATIENTS: Record<'Male' | 'Female', { name: string; age: number }[]> = {
  Male: [
    { name: 'Arokiasamy L', age: 61 }, { name: 'Senthil Kumar R', age: 44 }, { name: 'Babu Thomas', age: 53 }, { name: 'Murugesan P', age: 66 }, { name: 'Jayakumar S', age: 39 },
  ],
  Female: [
    { name: 'Sheeba Mary', age: 42 }, { name: 'Pushpa Rani', age: 57 }, { name: 'Meenakshi T', age: 35 }, { name: 'Leela Krishnan', age: 63 }, { name: 'Jansi Rani', age: 29 },
  ],
};

const tab = (medicine: string, product: string, dose: number, frequency: LineInput['frequency'], durationDays: number): LineInput => ({
  medicine, product, dose, route: 'oral', frequency, durationDays,
});

/**
 * Replaces everything the Discharge agent keeps with a demo: David Raj ordered Home 65 minutes ago with 5 of 7 lines done
 * (waiting on teaching and his bill), ten more real stays admitted through the Bed Agent's door in every state (due today
 * with the morning reminder, due tomorrow, overdue, Home waiting on the summary, Home waiting on Pharmacy, a transfer
 * waiting on its letter, one Ready to leave with the bill settled, and three that left today: Against advice and two Home,
 * one over the target), plans for the stays already in the hospital (James Wilson's as computed), and a week of hourly
 * snapshots. Everything goes through the live services, with a fixed clinic clock for the moments in the past (R7). Run
 * last, after seedRevenue: the stays are billed by Revenue's own services. Both agents' start stamps are set last, so
 * neither one-minute pass back-bills, re-sends or repairs a seeded record. No death, no Left without discharge, and no new
 * logins. `nowMs` is for tests, which pin the clock (Date) to it as well: the live services stamp their own records.
 */
export async function seedDischarge(clinicDay: string, nowMs: number = Date.now()): Promise<void> {
  if (Math.abs(Date.now() - nowMs) > 5 * MIN) throw new Error('Discharge seed: nowMs must be the clock now (a test pins Date to it): the live services stamp their records with it.');
  // The services read "today" from CLINIC_DATE, which the seed may run without, so the clinic day is pinned while it runs.
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
  const M = models();

  // ---- What the seed builds on, checked before anything is wiped ---------------------------------------
  const account = async (email: string): Promise<Actor> => {
    const u = await M.User.findOne({ email }).select('name role').lean<any>();
    if (!u) throw new Error(`Discharge seed: no user ${email}. Seed the users first.`);
    return { id: String(u._id), name: u.name as string, role: u.role as UserRole };
  };
  const doctor = await account('doctor@medios.ai');
  const nurse = await account('nurse@medios.ai');
  const desk = await account('frontdesk@medios.ai');
  const pharmacist = await account('pharmacy@medios.ai');
  const opDoctor = async (name: string) => {
    const d = await M.OpDoctor.findOne({ name }).select('_id').lean<any>();
    if (!d) throw new Error(`Discharge seed: no OP doctor ${name}. Run seedOpd and seedScheduling first.`);
    return String(d._id);
  };
  const shajin = await opDoctor('Dr. Shajin');
  const vinod = await opDoctor('Dr. Vinod Kumar');
  const john = await opDoctor('Dr. John Varghese');
  const david = await M.Patient.findOne({ uhid: DAVID_UHID }).lean<any>();
  if (!david) throw new Error(`Discharge seed: patient ${DAVID_UHID} not found. Seed the patients first.`);
  const davidAdmission = await M.Admission.findOne({ patient: david._id, status: 'active', sample: { $ne: true } }).lean<any>();
  if (!davidAdmission) throw new Error('Discharge seed: David Raj has no admission. Run the Bed seed first.');
  const davidBill = await M.Bill.findOne({ kind: 'admission', admission: davidAdmission._id }).lean<any>();
  if (!davidBill) throw new Error('Discharge seed: David Raj has no admission bill. Run the Revenue seed first.');
  if (!davidBill.case) throw new Error('Discharge seed: David Raj\'s bill has no case. Run the Revenue seed first.');
  // His results still to come: the tests the Lab seed left received on his case (LR-0016).
  const davidLines = await M.LabLine.find({ request: { $in: await M.LabRequest.find({ case: davidBill.case }).distinct('_id') }, status: { $nin: ['released', 'cancelled'] } })
    .select('request')
    .lean<any[]>();
  const davidRequests = [...new Set(davidLines.map((l) => String(l.request)))];
  if (!davidRequests.length) throw new Error('Discharge seed: David Raj has no Lab results to come. Run the Lab seed first.');

  // ---- The previous run's data, and nothing else, goes ------------------------------------------------
  const oldClockIds = (await M.Clock.find({ def: /^discharge-/ }).select('_id').lean<any[]>()).map((c) => String(c._id));
  const oldEscalationIds = (
    await M.Escalation.find({ $or: [{ ladder: { $in: ['discharge', 'discharge-doctor'] } }, { 'source.kind': 'discharge-left' }, { 'source.id': { $in: oldClockIds } }] })
      .select('_id')
      .lean<any[]>()
  ).map((e) => String(e._id));
  // The signed summaries' Documents records, current and kept versions, and their Timeline lines.
  const oldSummaries = await M.DischargeSummary.find().select('documentId versions.documentId').lean<any[]>();
  const oldDocumentIds = oldSummaries.flatMap((s) => [s.documentId, ...(s.versions ?? []).map((v: any) => v.documentId)]).filter((id) => id && Types.ObjectId.isValid(id));
  const oldUhids = await M.DischargePlan.distinct('patientUhid');
  await Promise.all([
    M.DischargePlan.deleteMany({}),
    M.DischargeOrder.deleteMany({}),
    M.DischargeSummary.deleteMany({}),
    M.DischargeSnapshot.deleteMany({}),
    M.AgentMessage.deleteMany({
      $or: [
        { from: 'discharge' },
        { dedupeKey: { $in: [...oldClockIds.map((id) => `clock.expired:${id}`), ...oldEscalationIds.map((id) => `escalation.raised:${id}`)] } },
      ],
    }),
    M.Clock.deleteMany({ def: /^discharge-/ }),
    M.Escalation.deleteMany({ _id: { $in: oldEscalationIds } }),
    M.TaskAlertItem.deleteMany({ $or: [{ link: /^discharge-/ }, { link: { $in: oldEscalationIds.map((id) => `escalation:${id}`) } }] }),
    M.CoordinatorCounter.deleteMany({ key: { $in: ['discharge-gatepass', DISCHARGE_START] } }),
    M.ClinicalDocument.deleteMany({ _id: { $in: oldDocumentIds } }),
    M.TimelineEvent.deleteMany({ uhid: { $in: oldUhids }, category: 'Admission', title: { $in: Object.values(SUMMARY_TITLE).map((t) => `${t} signed`) } }),
  ]);
  for (const m of [M.DischargePlan, M.DischargeOrder, M.DischargeSummary, M.DischargeSnapshot]) await m.syncIndexes();
  // Ward nurse in charge: the demo nurse (seedScheduling does the same; kept here for a database seeded without it).
  const wardTitle = DEFAULT_TITLES.find((t) => t.key === 'ward-nurse-in-charge')!;
  await M.DutyTitle.updateOne(
    { key: wardTitle.key },
    { $set: { holders: [new Types.ObjectId(nurse.id)] }, $setOnInsert: { key: wardTitle.key, label: wardTitle.label } },
    { upsert: true },
  );

  const w = wire();
  await w.escalations.ensureDefaults();
  // As in seedRevenue: the deposit and top-up listeners don't run on every bed day here; the seed calls them where a desk payment would.
  w.bills.onTotalsChanged.length = 0;
  const { leaveMinutes } = await w.dischargeSettings.get();

  // ---- The clinic clock -------------------------------------------------------------------------------
  const now = clinicNow();
  const dayStart = parseIsoDay(clinicDay).getTime();
  // Early in the clinic day the stories are drawn closer to now, so every "earlier today" stays today.
  const scale = Math.max(0, Math.min(1, (now.getTime() - dayStart - MIN) / (STORY_SPAN_MIN * MIN)));
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MIN * scale);
  /** Sets the Discharge services' clinic clock to `at` (R7); null puts the live clock back. */
  const clockAt = (at: Date | null) => {
    const c = at ? () => new Date(at.getTime()) : () => clinicNow();
    w.plans.clock = c;
    w.orders.clock = c;
    w.lines.clock = c;
    w.summary.clock = c;
    w.leaving.clock = c;
    w.overview.clock = c;
  };
  /** Runs `work` with the clinic day `daysAgo` days back: the Bed and Revenue services stamp their records then. */
  const onDayBack = async <T>(daysAgo: number, work: () => Promise<T>): Promise<T> => {
    const day = parseIsoDay(clinicDay);
    day.setDate(day.getDate() - daysAgo);
    process.env.CLINIC_DATE = isoDate(day);
    try {
      return await work();
    } finally {
      process.env.CLINIC_DATE = clinicDay;
    }
  };

  // ---- The stays already in the hospital (James Wilson's, David Raj's) get their plans, as computed ------
  await w.plans.catchUp();

  // ---- Free patients and free beds, from the hospital as the other seeds left it ------------------------
  const busy = new Set<string>(
    (
      await Promise.all([
        M.Admission.distinct('patient', { status: 'active' }),
        M.ErVisit.distinct('patient'),
        M.Case.distinct('patient'),
        M.Bill.distinct('patient'),
        M.ProcedureBooking.distinct('patient'),
        M.ConsultRequest.distinct('patient'),
      ])
    ).flat().map(String),
  );
  const outpatientsToday = new Set<string>((await M.Appointment.distinct('uhid', { date: clinicDay, status: { $ne: 'Cancelled' } })).map(String));
  // Adults with no other agent's work on them, those with no outpatient visit today first.
  const free = (await M.Patient.find({ detailsPending: { $ne: true }, address: { $ne: DISCHARGE_MARK } }).sort({ uhid: 1 }).lean<any[]>())
    .filter((p) => !busy.has(String(p._id)) && (p.age ?? 0) >= 14 && !OTHER_STORIES.test(String(p.name).trim()))
    .sort((a, b) => Number(outpatientsToday.has(a.uhid)) - Number(outpatientsToday.has(b.uhid)));
  // Made-up patients of an earlier run with no stay any more go; a hospital short of free patients gets new ones.
  await M.Patient.deleteMany({ address: DISCHARGE_MARK, _id: { $nin: await M.Admission.distinct('patient', { status: 'active' }) } });
  const spare = { Male: 0, Female: 0 };
  const take = async (gender: 'Male' | 'Female' | 'any') => {
    const i = free.findIndex((p) => gender === 'any' || p.gender === gender);
    if (i >= 0) return free.splice(i, 1)[0];
    const g = gender === 'any' ? 'Female' : gender;
    const made = SPARE_PATIENTS[g][spare[g]++];
    if (!made) throw new Error(`Discharge seed: not enough free ${g.toLowerCase()} patients.`);
    return (await w.patients.create({ name: made.name, age: made.age, gender: g, phone: `90000097${String(spare.Male + spare.Female).padStart(2, '0')}`, address: DISCHARGE_MARK })).toObject();
  };
  const wardOf = async (code: string) => {
    const ward = await M.Ward.findOne({ code }).lean<any>();
    if (!ward) throw new Error(`Discharge seed: no ward ${code}. Run the Bed seed first.`);
    return { ward, beds: await M.Bed.find({ ward: ward._id, state: 'free' }).sort({ number: 1 }).lean<any[]>() };
  };
  const wards = { GWA: await wardOf('GWA'), GWB: await wardOf('GWB'), PVT: await wardOf('PVT') };
  const freeBed = (code: Stay['ward']) => {
    const bed = wards[code].beds.shift();
    if (!bed) throw new Error(`Discharge seed: no free bed left in ${wards[code].ward.name}.`);
    return bed;
  };

  // ---- Small helpers ---------------------------------------------------------------------------------
  const modes = ['cash', 'upi', 'card'] as const;
  let paid = 0;
  const pay = async (billId: string, amount: number, kind: 'deposit' | 'settlement') => {
    const mode = modes[paid++ % 3];
    await w.payments.record(desk, billId, { amount, mode, kind, ...(mode === 'upi' ? { reference: `UPI-DEMO-${String(2000 + paid)}` } : {}) });
  };
  const activeBill = async (admissionId: unknown) => {
    const bill = await M.Bill.findOne({ kind: 'admission', admission: admissionId, state: { $in: ['open', 'final'] } }).lean<any>();
    if (!bill) throw new Error('Discharge seed: a stay has no active admission bill.');
    return bill;
  };

  /**
   * A stay admitted `daysAgo` days back, at the same time of day: the Bed Agent places the patient in the bed (its own
   * door), the case is opened or joined with the admission on it (as the bed bridge does on a placement), Revenue opens
   * the bill with its bed days, estimate and deposit task, the deposit is paid at the desk, and the plan opens on the case.
   */
  const admit = async (key: StayKey) => {
    const stay: Stay = STAYS[key];
    const wardGender = wards[stay.ward].ward.gender as string;
    const patient = await take(wardGender === 'male' ? 'Male' : wardGender === 'female' ? 'Female' : 'any');
    const bed = freeBed(stay.ward);
    return onDayBack(stay.daysAgo, async () => {
      const admission = await w.beds.admitToFreeBed(String(bed._id), AGENT_ACTOR, {
        patientId: String(patient._id),
        doctor: stay.doctor,
        department: stay.department,
        roomClass: (stay.ward === 'PVT' ? 'private' : 'general') as RoomClass,
        needs: [],
        notes: stay.notes,
        expectedStayDays: stay.stayDays,
      });
      const admissionId = String(admission._id);
      const { case: c } = await w.cases.openOrJoin({
        patientId: String(patient._id), patientUhid: patient.uhid, patientName: patient.name, kind: 'ipd', priority: 'medium', openedBy: 'bed',
      });
      const caseId = String(c._id);
      await w.cases.addRefs(caseId, { admissionId });
      await (w.bedDays as any).onAssigned({ case: caseId, payload: { admissionId } });
      const bill = await activeBill(admission._id);
      const due = await w.deposits.dueFor((await M.Bill.findById(bill._id))!);
      if (due) {
        await pay(String(bill._id), due.amount, 'deposit');
        await w.deposits.closeIfMet(String(bill._id));
        await w.deposits.checkTopUp(String(bill._id));
      }
      const plan = await w.plans.ensurePlan(admissionId, caseId);
      if (!plan) throw new Error(`Discharge seed: no plan opened for ${bed.label}.`);
      return { patient, bed, admissionId, caseId, planId: String(plan._id) };
    });
  };

  /**
   * The doctor's order, given at `at`. With `windowAt` later than `at`, the planned leaving time is the window plus the
   * target, the summary can be signed (`signAt`) before the window opens, and the window then opens at `windowAt` through
   * the one-minute pass's own step, saying the summary is signed: no summary clock starts (R20). Without it, the window
   * opens with the order. The background draft is waited for before any signature (R36).
   */
  const give = async (planId: string, input: Omit<OrderInput, 'plannedLeaveAt'>, at: Date, opts: { windowAt?: Date; signAt?: Date } = {}) => {
    clockAt(at);
    const order = await w.orders.order(doctor, planId, {
      ...input,
      ...(opts.windowAt ? { plannedLeaveAt: new Date(opts.windowAt.getTime() + leaveMinutes * MIN) } : {}),
    } as OrderInput);
    const orderId = String(order._id);
    await w.orders.idle();
    if (opts.signAt) {
      clockAt(opts.signAt);
      await w.summary.sign(doctor, orderId);
    }
    if (opts.windowAt) {
      clockAt(opts.windowAt);
      await w.orders.openDueWindows(opts.windowAt);
    }
    const saved = await M.DischargeOrder.findById(orderId).lean<any>();
    if (!saved?.windowOpenedAt) throw new Error('Discharge seed: an order\'s window did not open.');
    return saved;
  };

  /** The order's take-home medicines checked by the pharmacist, and issued from stock when `issued`. Read only through takeHomeOrderIds. */
  const pharmacy = async (order: any, issued: boolean) => {
    const medicines = await M.PharmacyLine.find({ order: { $in: takeHomeOrderIds(order) } }).sort({ _id: 1 }).lean<any[]>();
    if (!medicines.length) throw new Error('Discharge seed: a take-home order has no medicines.');
    const red = medicines.filter((l) => (l.flags ?? []).some((f: any) => f.severity === 'red'));
    if (red.length) throw new Error(`Discharge seed: a take-home medicine has a red safety flag (${red.map((l) => l.medicine).join(', ')}).`);
    for (const l of medicines) await w.checks.approve(pharmacist, String(l._id), {});
    if (issued) for (const l of medicines) await w.issue.issue(pharmacist, String(l._id), { store: 'main' });
  };

  /** The nurse ticks hand lines at `at`. */
  const tick = async (orderId: string, keys: ('teaching' | 'ama-form')[], at: Date) => {
    clockAt(at);
    for (const key of keys) await w.lines.tick(nurse, orderId, key, { state: 'done' });
  };

  /**
   * The bill at the desk, through Revenue's own path: the bed days up to `at`, the final bill prepared, the balance paid
   * and the bill settled (Settle needs a final bill at zero). Revenue stamps these on the live clinic clock.
   */
  const settle = async (admissionId: string, at: Date) => {
    await w.bedDays.chargeDue(admissionId, at);
    const bill = await activeBill(new Types.ObjectId(admissionId));
    await w.final.prepare(desk, String(bill._id));
    const balance = (await M.Bill.findById(bill._id).lean<any>())!.totals.balance;
    if (balance > 0) await pay(String(bill._id), balance, 'settlement');
    await w.final.settle(desk, String(bill._id));
  };

  /** The gate pass printed at the desk at `passAt`, then the nurse records Patient left at `leftAt`. */
  const leave = async (orderId: string, passAt: Date, leftAt: Date) => {
    clockAt(passAt);
    await w.leaving.gatePass(desk, orderId);
    clockAt(leftAt);
    await w.leaving.left(nurse, orderId);
  };

  // ---- David Raj (A14): target moved to today, ordered Home, 5 of 7 done; waiting on teaching and his bill ----
  const davidPlan = await M.DischargePlan.findOne({ admission: davidAdmission._id }).lean<any>();
  if (!davidPlan) throw new Error('Discharge seed: David Raj has no plan.');
  clockAt(ago(70));
  await w.plans.setTarget(doctor, String(davidPlan._id), clinicDay, 'Wound healing well; fit to go home today');
  const davidOrder = await give(
    String(davidPlan._id),
    {
      kind: 'home',
      diagnosis: 'Recovering well after surgery; wound clean and healing',
      condition: 'improved',
      note: 'Dressing change at the follow-up visit.',
      // Two medicines neither on his active lines nor of their classes (his are a PPI, a P2Y12, an antihistamine, paracetamol and a CCB).
      takeHome: { lines: [tab('amoxicillin', 'amoxicillin-cap-500', 500, 'TDS', 5), tab('tramadol', 'tramadol-cap-50', 50, 'BD', 3)] },
      followUp: { inDays: 7, doctorId: shajin },
    },
    ago(65),
    { windowAt: ago(60), signAt: ago(63) },
  );
  clockAt(ago(62));
  for (const requestId of davidRequests) await w.lines.followUpLater(doctor, String(davidOrder._id), requestId);
  await pharmacy(davidOrder, true);

  // ---- No order yet: due today (the morning reminder), due tomorrow, and overdue ------------------------
  const dueToday = await admit('dueToday');
  await admit('dueTomorrow');
  await admit('overdue');

  // ---- Home, ordered 25 minutes ago: the summary is not signed yet (its clock runs) ------------------------
  const noSummary = await admit('noSummary');
  const noSummaryOrder = await give(
    noSummary.planId,
    {
      kind: 'home',
      diagnosis: 'Community-acquired pneumonia, treated',
      condition: 'improved',
      takeHome: { lines: [tab('azithromycin', 'azithromycin-tab-500', 500, 'OD', 3), tab('paracetamol', 'paracetamol-tab-650', 650, 'TDS', 3)] },
      followUp: { inDays: 10, doctorId: shajin },
    },
    ago(25),
  );
  await pharmacy(noSummaryOrder, true);

  // ---- Home, ordered 40 minutes ago: the take-home medicines are approved and wait in Pharmacy ---------------
  const noTakeHome = await admit('noTakeHome');
  const noTakeHomeOrder = await give(
    noTakeHome.planId,
    {
      kind: 'home',
      diagnosis: 'Closed fracture of the left distal radius, in plaster',
      condition: 'stable',
      takeHome: { lines: [tab('paracetamol', 'paracetamol-tab-650', 650, 'TDS', 5), tab('diclofenac', 'diclofenac-tab-50', 50, 'BD', 5)] },
      followUp: { inDays: 14, doctorId: john, note: 'Plaster check and X-ray' },
    },
    ago(40),
    { windowAt: ago(35), signAt: ago(38) },
  );
  await pharmacy(noTakeHomeOrder, false);
  await tick(String(noTakeHomeOrder._id), ['teaching'], ago(30));

  // ---- Transfer, ordered 15 minutes ago: the transfer letter is not signed yet ---------------------------
  const transfer = await admit('transfer');
  await give(
    transfer.planId,
    {
      kind: 'transfer',
      diagnosis: 'Intracerebral haemorrhage with right-sided weakness',
      condition: 'stable',
      receivingHospital: 'Government Medical College Hospital, Thiruvananthapuram',
      transferReason: 'Needs a neurosurgical opinion',
      takeHome: 'none',
    },
    ago(15),
  );

  // ---- Home, Ready to leave: the bill settled, no gate pass printed yet -------------------------------------
  const ready = await admit('ready');
  const readyOrder = await give(
    ready.planId,
    {
      kind: 'home',
      diagnosis: 'Dengue fever without warning signs, recovered',
      condition: 'improved',
      takeHome: { lines: [tab('paracetamol', 'paracetamol-tab-500', 500, 'TDS', 3)] },
      followUp: { inDays: 7, doctorId: shajin, note: 'Platelet count on arrival' },
    },
    ago(90),
    { windowAt: ago(85), signAt: ago(88) },
  );
  await pharmacy(readyOrder, true);
  await tick(String(readyOrder._id), ['teaching'], ago(40));
  await settle(ready.admissionId, ago(30));

  // ---- Left today: Against advice --------------------------------------------------------------------------
  const againstAdvice = await admit('againstAdvice');
  const amaOrder = await give(
    againstAdvice.planId,
    {
      kind: 'against-advice',
      diagnosis: 'Alcoholic liver disease with ascites',
      condition: 'unchanged',
      note: 'The family is taking him home against medical advice; the risks were explained.',
    },
    ago(100),
    { windowAt: ago(95), signAt: ago(98) },
  );
  await tick(String(amaOrder._id), ['ama-form'], ago(70));
  await tick(String(amaOrder._id), ['teaching'], ago(60));
  await settle(againstAdvice.admissionId, ago(55));
  await leave(String(amaOrder._id), ago(50), ago(45));

  // ---- Left today: Home, within the target (85 minutes from the window) ------------------------------------
  const onTime = await admit('onTime');
  const onTimeOrder = await give(
    onTime.planId,
    {
      kind: 'home',
      diagnosis: 'Acute appendicitis, open appendectomy; wound healed',
      condition: 'improved',
      takeHome: { lines: [tab('amoxicillin', 'amoxicillin-cap-500', 500, 'TDS', 5), tab('paracetamol', 'paracetamol-tab-650', 650, 'TDS', 3)] },
      followUp: { inDays: 7, doctorId: vinod, note: 'Wound review' },
    },
    ago(240),
    { windowAt: ago(235), signAt: ago(238) },
  );
  await pharmacy(onTimeOrder, true);
  await tick(String(onTimeOrder._id), ['teaching'], ago(180));
  await settle(onTime.admissionId, ago(160));
  await leave(String(onTimeOrder._id), ago(155), ago(150));

  // ---- Left today: Home, over the target (160 minutes from the window) --------------------------------------
  const overTarget = await admit('overTarget');
  const overTargetOrder = await give(
    overTarget.planId,
    {
      kind: 'home',
      diagnosis: 'Type 2 diabetes, poorly controlled; insulin started',
      condition: 'improved',
      takeHome: { lines: [tab('metformin', 'metformin-tab-500', 500, 'BD', 30), tab('glimepiride', 'glimepiride-tab-1', 1, 'OD', 30)] },
      followUp: { inDays: 7, doctorId: shajin, note: 'Fasting sugar on arrival' },
    },
    ago(330),
    { windowAt: ago(325), signAt: ago(328) },
  );
  await pharmacy(overTargetOrder, true);
  await tick(String(overTargetOrder._id), ['teaching'], ago(200));
  await settle(overTarget.admissionId, ago(175));
  await leave(String(overTargetOrder._id), ago(170), ago(165));

  // ---- Now: every stay's bed days to this moment (Revenue's own pass), the morning reminder, the lines read again ----
  clockAt(null);
  await w.bedDays.tick();
  await w.plans.catchUp();
  await w.plans.remindDue();
  await w.lines.refreshOpen();
  if (!(await M.DischargePlan.exists({ _id: dueToday.planId, state: 'planned', targetDay: clinicDay }))) throw new Error('Discharge seed: the due-today stay is not due today.');

  // ---- A week of hourly readings; the live one is this hour's -------------------------------------------------
  await M.DischargeSnapshot.insertMany(history(nowMs));
  await w.overview.snapshot();

  // ---- Start stamps, last (R54, carry-forwards 9 and 10): Discharge's and Revenue's minute passes look only at records
  // written after this, so neither re-sends, repairs or back-bills a seeded stay. One millisecond on, so a record written in
  // the stamp's own millisecond is still before it.
  const stamp = Date.now() + 1;
  await M.CoordinatorCounter.deleteMany({ key: { $in: [DISCHARGE_START, 'revenue-start'] } });
  for (const key of [DISCHARGE_START, 'revenue-start']) await M.CoordinatorCounter.updateOne({ key }, { $set: { last: stamp } }, { upsert: true });

  const orders = await M.DischargeOrder.find().lean<any[]>();
  const byState = (s: string) => orders.filter((o) => o.state === s).length;
  console.log(
    `✅ Discharge: ${await M.DischargePlan.countDocuments()} plans, ${orders.length} orders (${byState('ordered')} ordered, ${byState('ready')} ready, ` +
      `${byState('left')} left today), ${await M.DischargeSummary.countDocuments({ signedAt: { $ne: null } })} summaries signed, ` +
      `${await M.DischargeSnapshot.countDocuments()} snapshots`,
  );
}

/** The card values at every hour of the last week but this one (the live snapshot adds this hour). */
function history(nowMs: number): Record<string, any>[] {
  const lastHour = hourOf(new Date(nowMs)).getTime();
  let seed = 5112026;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 167 }, (_, k) => {
    const at = new Date(lastHour - (167 - k) * HOUR);
    const h = at.getHours();
    // The day's discharges: due from the morning, ordered through the late morning, leaving from about 10 to 18.
    const dueToday = 5 + Math.round(rng() * 4);
    const leftToday = h < 10 ? 0 : Math.min(dueToday, Math.max(0, Math.round(((Math.min(h, 18) - 9) / 9) * (dueToday - 1) + (rng() - 0.5))));
    const noOrder = Math.max(0, Math.min(dueToday - leftToday, h < 9 ? dueToday - 1 : Math.round((1 - Math.min(1, (h - 9) / 5)) * 3 + (rng() - 0.5))));
    const inProgress = Math.max(0, dueToday - leftToday - noOrder);
    const ready = h >= 9 && h <= 18 ? Math.min(inProgress, Math.round(rng() * 2)) : 0;
    const clearing = inProgress - ready;
    return {
      at,
      counts: {
        dueToday,
        noOrder,
        clearing,
        ready,
        leftToday,
        avgMinutes: leftToday ? 95 + Math.round(rng() * 50) : null,
        bedsFreeing: inProgress + leftToday,
      },
    };
  });
}
