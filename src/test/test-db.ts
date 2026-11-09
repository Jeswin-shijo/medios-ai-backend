import mongoose, { Model, Schema } from 'mongoose';
import { Admission, AdmissionDocument, AdmissionSchema } from '../modules/beds/schemas/admission.schema';
import { Bed, BedDocument, BedSchema } from '../modules/beds/schemas/bed.schema';
import { BedSuggestion, BedSuggestionDocument, BedSuggestionSchema } from '../modules/beds/schemas/bed-suggestion.schema';
import { BedSnapshot, BedSnapshotDocument, BedSnapshotSchema } from '../modules/beds/schemas/bed-snapshot.schema';
import { BedRequest, BedRequestDocument, BedRequestSchema } from '../modules/beds/schemas/bed-request.schema';
import { TaskAlertItem, TaskAlertDocument, TaskAlertItemSchema } from '../modules/tasks-alerts/schemas/task-alert.schema';
import { Ward, WardDocument, WardSchema } from '../modules/beds/schemas/ward.schema';
import { Patient, PatientDocument, PatientSchema } from '../modules/patients/schemas/patient.schema';
import { AgentMessage, MessageDocument, AgentMessageSchema } from '../modules/coordinator/schemas/agent-message.schema';
import { Case, CaseDocument, CaseSchema } from '../modules/coordinator/schemas/case.schema';
import { CoordinatorCounter, CoordinatorCounterDocument, CoordinatorCounterSchema } from '../modules/coordinator/schemas/coordinator-counter.schema';
import { TimelineEvent, TimelineEventDocument, TimelineEventSchema } from '../modules/timeline/schemas/timeline.schema';
import { HospitalSettings, HospitalSettingsDocument, HospitalSettingsSchema } from '../modules/settings/schemas/settings.schema';
import { DutyTitle, DutyTitleDocument, DutyTitleSchema } from '../modules/coordinator/schemas/duty-title.schema';
import { Ladder, LadderDocument, LadderSchema } from '../modules/coordinator/schemas/ladder.schema';
import { Escalation, EscalationDocument, EscalationSchema } from '../modules/coordinator/schemas/escalation.schema';
import { Clock, ClockDocument, ClockSchema } from '../modules/coordinator/schemas/clock.schema';
import { Approval, ApprovalDocument, ApprovalSchema } from '../modules/coordinator/schemas/approval.schema';
import { CoordinatorSnapshot, CoordinatorSnapshotDocument, CoordinatorSnapshotSchema } from '../modules/coordinator/schemas/coordinator-snapshot.schema';
import { ChatLog, ChatLogDocument, ChatLogSchema } from '../modules/coordinator/schemas/chat-log.schema';
import { ErVisit, ErVisitDocument, ErVisitSchema } from '../modules/er/schemas/er-visit.schema';
import { ErBay, ErBayDocument, ErBaySchema } from '../modules/er/schemas/er-bay.schema';
import { ErExpected, ErExpectedDocument, ErExpectedSchema } from '../modules/er/schemas/er-expected.schema';
import { ErSnapshot, ErSnapshotDocument, ErSnapshotSchema } from '../modules/er/schemas/er-snapshot.schema';
import { VitalsRecord, VitalsRecordDocument, VitalsRecordSchema } from '../modules/vitals/schemas/vitals.schema';
import { PatientCard, PatientCardDocument, PatientCardSchema } from '../modules/queue/schemas/patient-card.schema';
import { LabRequest, LabRequestDocument, LabRequestSchema } from '../modules/lab/schemas/lab-request.schema';
import { LabLine, LabLineDocument, LabLineSchema } from '../modules/lab/schemas/lab-line.schema';
import { LabSample, LabSampleDocument, LabSampleSchema } from '../modules/lab/schemas/lab-sample.schema';
import { LabLocation, LabLocationDocument, LabLocationSchema } from '../modules/lab/schemas/lab-location.schema';
import { LabSnapshot, LabSnapshotDocument, LabSnapshotSchema } from '../modules/lab/schemas/lab-snapshot.schema';
import { PharmacyOrder, PharmacyOrderDocument, PharmacyOrderSchema } from '../modules/pharmacy/schemas/pharmacy-order.schema';
import { PharmacyLine, PharmacyLineDocument, PharmacyLineSchema } from '../modules/pharmacy/schemas/pharmacy-line.schema';
import { PharmacyLocation, PharmacyLocationDocument, PharmacyLocationSchema } from '../modules/pharmacy/schemas/pharmacy-location.schema';
import { PharmacyBatch, PharmacyBatchDocument, PharmacyBatchSchema } from '../modules/pharmacy/schemas/pharmacy-batch.schema';
import { PharmacyMovement, PharmacyMovementDocument, PharmacyMovementSchema } from '../modules/pharmacy/schemas/pharmacy-movement.schema';
import { PharmacySnapshot, PharmacySnapshotDocument, PharmacySnapshotSchema } from '../modules/pharmacy/schemas/pharmacy-snapshot.schema';
import { PharmacyStockLevel, PharmacyStockLevelDocument, PharmacyStockLevelSchema } from '../modules/pharmacy/schemas/pharmacy-stock-level.schema';
import { PharmacyProcedureNote, PharmacyProcedureNoteDocument, PharmacyProcedureNoteSchema } from '../modules/pharmacy/schemas/pharmacy-procedure-note.schema';
import { LabTestReport, LabReportDocument, LabTestReportSchema } from '../modules/lab-reports/schemas/lab-report.schema';
import { Prescription, PrescriptionDocument, PrescriptionSchema } from '../modules/prescriptions/schemas/prescription.schema';
import { User, UserDocument, UserSchema } from '../modules/users/schemas/user.schema';
import { QueueToken, QueueTokenDocument, QueueTokenSchema } from '../modules/queue/schemas/queue-token.schema';
import { QueueSequence, QueueSequenceDocument, QueueSequenceSchema } from '../modules/queue/schemas/queue-sequence.schema';
import { Appointment, AppointmentDocument, AppointmentSchema } from '../modules/appointments/schemas/appointment.schema';
import { FollowUpItem, FollowUpDocument, FollowUpItemSchema } from '../modules/follow-ups/schemas/follow-up.schema';
import { AgentCall, AgentCallDocument, AgentCallSchema } from '../modules/calls/schemas/agent-call.schema';
import { InboundSession, InboundSessionDocument, InboundSessionSchema } from '../modules/calls/schemas/inbound-session.schema';
import { CallerLookup, CallerLookupDocument, CallerLookupSchema } from '../modules/calls/schemas/caller-lookup.schema';
import { Department, DepartmentDocument, DepartmentSchema } from '../modules/opd/schemas/department.schema';
import { OpDoctor, OpDoctorDocument, OpDoctorSchema } from '../modules/opd/schemas/op-doctor.schema';
import { StaffMember, StaffMemberDocument, StaffMemberSchema } from '../modules/scheduling/schemas/staff-member.schema';
import { RosterEntry, RosterEntryDocument, RosterEntrySchema } from '../modules/scheduling/schemas/roster-entry.schema';
import { DoctorProfile, DoctorProfileDocument, DoctorProfileSchema } from '../modules/scheduling/schemas/doctor-profile.schema';
import { RoomBlock, RoomBlockDocument, RoomBlockSchema } from '../modules/scheduling/schemas/room-block.schema';
import { ProcedureBooking, ProcedureBookingDocument, ProcedureBookingSchema } from '../modules/scheduling/schemas/procedure-booking.schema';
import { ConsultRequest, ConsultRequestDocument, ConsultRequestSchema } from '../modules/scheduling/schemas/consult-request.schema';
import { WaitItem, WaitItemDocument, WaitItemSchema } from '../modules/scheduling/schemas/wait-item.schema';
import { SchedulingSnapshot, SchedulingSnapshotDocument, SchedulingSnapshotSchema } from '../modules/scheduling/schemas/scheduling-snapshot.schema';
import { SchedulingLock, SchedulingLockDocument, SchedulingLockSchema } from '../modules/scheduling/schemas/scheduling-lock.schema';
import { PriceItem, PriceItemDocument, PriceItemSchema } from '../modules/revenue/schemas/price-item.schema';
import { Bill, BillDocument, BillSchema } from '../modules/revenue/schemas/bill.schema';
import { ChargeLine, ChargeLineDocument, ChargeLineSchema } from '../modules/revenue/schemas/charge-line.schema';
import { Estimate, EstimateDocument, EstimateSchema } from '../modules/revenue/schemas/estimate.schema';
import { Payment, PaymentDocument, PaymentSchema } from '../modules/revenue/schemas/payment.schema';
import { Refund, RefundDocument, RefundSchema } from '../modules/revenue/schemas/refund.schema';
import { Correction, CorrectionDocument, CorrectionSchema } from '../modules/revenue/schemas/correction.schema';
import { RevenueSnapshot, RevenueSnapshotDocument, RevenueSnapshotSchema } from '../modules/revenue/schemas/revenue-snapshot.schema';
import { ClinicalDocument, ClinicalDocumentDocument, ClinicalDocumentSchema } from '../modules/documents/schemas/document.schema';
import { DischargePlan, DischargePlanDocument, DischargePlanSchema } from '../modules/discharge/schemas/discharge-plan.schema';
import { DischargeOrder, DischargeOrderDocument, DischargeOrderSchema } from '../modules/discharge/schemas/discharge-order.schema';
import { DischargeSummary, DischargeSummaryDocument, DischargeSummarySchema } from '../modules/discharge/schemas/discharge-summary.schema';
import { DischargeSnapshot, DischargeSnapshotDocument, DischargeSnapshotSchema } from '../modules/discharge/schemas/discharge-snapshot.schema';
import { QueueDisplay, QueueDisplayDocument, QueueDisplaySchema } from '../modules/queue/schemas/queue-display.schema';
import { BillInvoice, BillInvoiceDocument, BillInvoiceSchema } from '../modules/billing/schemas/bill.schema';
import { ReceptionSession, ReceptionSessionDocument, ReceptionSessionSchema } from '../modules/reception/schemas/reception-session.schema';
import { OtpChallenge, OtpChallengeDocument, OtpChallengeSchema } from '../modules/reception/schemas/otp-challenge.schema';
import { OpVisit, OpVisitDocument, OpVisitSchema } from '../modules/reception/schemas/op-visit.schema';
import { OpSequence, OpSequenceDocument, OpSequenceSchema } from '../modules/reception/schemas/op-sequence.schema';

// Database specs share one throwaway database. The name check stops a stray
// MONGODB_TEST_URI from wiping a real one (medios_hospital, medios_beds_dev, medios_reception_dev).

const DEFAULT_URI = 'mongodb://localhost:27017/medios_test';

/** The database name in a MongoDB URI: the path after the hosts, before any options. */
function databaseName(uri: string): string {
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('?')[0];
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : decodeURIComponent(rest.slice(slash + 1));
}

function assertTestDatabase(name: string) {
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use database "${name}" for tests: its name must end in _test.`);
  }
}

const model = (cls: { name: string }, schema: Schema): Model<any> => mongoose.models[cls.name] ?? mongoose.model(cls.name, schema);

/** The models the database specs use, registered once on the default connection. */
export function models() {
  return {
    Ward: model(Ward, WardSchema) as Model<WardDocument>,
    Bed: model(Bed, BedSchema) as Model<BedDocument>,
    Admission: model(Admission, AdmissionSchema) as Model<AdmissionDocument>,
    BedSuggestion: model(BedSuggestion, BedSuggestionSchema) as Model<BedSuggestionDocument>,
    Patient: model(Patient, PatientSchema) as Model<PatientDocument>,
    BedRequest: model(BedRequest, BedRequestSchema) as Model<BedRequestDocument>,
    BedSnapshot: model(BedSnapshot, BedSnapshotSchema) as Model<BedSnapshotDocument>,
    TaskAlertItem: model(TaskAlertItem, TaskAlertItemSchema) as Model<TaskAlertDocument>,
    AgentMessage: model(AgentMessage, AgentMessageSchema) as Model<MessageDocument>,
    Case: model(Case, CaseSchema) as Model<CaseDocument>,
    CoordinatorCounter: model(CoordinatorCounter, CoordinatorCounterSchema) as Model<CoordinatorCounterDocument>,
    TimelineEvent: model(TimelineEvent, TimelineEventSchema) as Model<TimelineEventDocument>,
    DutyTitle: model(DutyTitle, DutyTitleSchema) as Model<DutyTitleDocument>,
    Ladder: model(Ladder, LadderSchema) as Model<LadderDocument>,
    Escalation: model(Escalation, EscalationSchema) as Model<EscalationDocument>,
    Clock: model(Clock, ClockSchema) as Model<ClockDocument>,
    Approval: model(Approval, ApprovalSchema) as Model<ApprovalDocument>,
    CoordinatorSnapshot: model(CoordinatorSnapshot, CoordinatorSnapshotSchema) as Model<CoordinatorSnapshotDocument>,
    ChatLog: model(ChatLog, ChatLogSchema) as Model<ChatLogDocument>,
    ErVisit: model(ErVisit, ErVisitSchema) as Model<ErVisitDocument>,
    ErSnapshot: model(ErSnapshot, ErSnapshotSchema) as Model<ErSnapshotDocument>,
    VitalsRecord: model(VitalsRecord, VitalsRecordSchema) as Model<VitalsRecordDocument>,
    ErBay: model(ErBay, ErBaySchema) as Model<ErBayDocument>,
    ErExpected: model(ErExpected, ErExpectedSchema) as Model<ErExpectedDocument>,
    PatientCard: model(PatientCard, PatientCardSchema) as Model<PatientCardDocument>,
    LabRequest: model(LabRequest, LabRequestSchema) as Model<LabRequestDocument>,
    LabLine: model(LabLine, LabLineSchema) as Model<LabLineDocument>,
    LabSample: model(LabSample, LabSampleSchema) as Model<LabSampleDocument>,
    LabLocation: model(LabLocation, LabLocationSchema) as Model<LabLocationDocument>,
    LabSnapshot: model(LabSnapshot, LabSnapshotSchema) as Model<LabSnapshotDocument>,
    LabTestReport: model(LabTestReport, LabTestReportSchema) as Model<LabReportDocument>,
    PharmacyOrder: model(PharmacyOrder, PharmacyOrderSchema) as Model<PharmacyOrderDocument>,
    PharmacyLine: model(PharmacyLine, PharmacyLineSchema) as Model<PharmacyLineDocument>,
    PharmacyLocation: model(PharmacyLocation, PharmacyLocationSchema) as Model<PharmacyLocationDocument>,
    PharmacyBatch: model(PharmacyBatch, PharmacyBatchSchema) as Model<PharmacyBatchDocument>,
    PharmacyMovement: model(PharmacyMovement, PharmacyMovementSchema) as Model<PharmacyMovementDocument>,
    PharmacySnapshot: model(PharmacySnapshot, PharmacySnapshotSchema) as Model<PharmacySnapshotDocument>,
    PharmacyStockLevel: model(PharmacyStockLevel, PharmacyStockLevelSchema) as Model<PharmacyStockLevelDocument>,
    PharmacyProcedureNote: model(PharmacyProcedureNote, PharmacyProcedureNoteSchema) as Model<PharmacyProcedureNoteDocument>,
    Prescription: model(Prescription, PrescriptionSchema) as Model<PrescriptionDocument>,
    User: model(User, UserSchema) as Model<UserDocument>,
    HospitalSettings: model(HospitalSettings, HospitalSettingsSchema) as Model<HospitalSettingsDocument>,
    Appointment: model(Appointment, AppointmentSchema) as Model<AppointmentDocument>,
    QueueToken: model(QueueToken, QueueTokenSchema) as Model<QueueTokenDocument>,
    QueueSequence: model(QueueSequence, QueueSequenceSchema) as Model<QueueSequenceDocument>,
    FollowUpItem: model(FollowUpItem, FollowUpItemSchema) as Model<FollowUpDocument>,
    AgentCall: model(AgentCall, AgentCallSchema) as Model<AgentCallDocument>,
    InboundSession: model(InboundSession, InboundSessionSchema) as Model<InboundSessionDocument>,
    CallerLookup: model(CallerLookup, CallerLookupSchema) as Model<CallerLookupDocument>,
    Department: model(Department, DepartmentSchema) as Model<DepartmentDocument>,
    OpDoctor: model(OpDoctor, OpDoctorSchema) as Model<OpDoctorDocument>,
    StaffMember: model(StaffMember, StaffMemberSchema) as Model<StaffMemberDocument>,
    RosterEntry: model(RosterEntry, RosterEntrySchema) as Model<RosterEntryDocument>,
    DoctorProfile: model(DoctorProfile, DoctorProfileSchema) as Model<DoctorProfileDocument>,
    RoomBlock: model(RoomBlock, RoomBlockSchema) as Model<RoomBlockDocument>,
    ProcedureBooking: model(ProcedureBooking, ProcedureBookingSchema) as Model<ProcedureBookingDocument>,
    ConsultRequest: model(ConsultRequest, ConsultRequestSchema) as Model<ConsultRequestDocument>,
    WaitItem: model(WaitItem, WaitItemSchema) as Model<WaitItemDocument>,
    SchedulingSnapshot: model(SchedulingSnapshot, SchedulingSnapshotSchema) as Model<SchedulingSnapshotDocument>,
    SchedulingLock: model(SchedulingLock, SchedulingLockSchema) as Model<SchedulingLockDocument>,
    PriceItem: model(PriceItem, PriceItemSchema) as Model<PriceItemDocument>,
    Bill: model(Bill, BillSchema) as Model<BillDocument>,
    ChargeLine: model(ChargeLine, ChargeLineSchema) as Model<ChargeLineDocument>,
    Estimate: model(Estimate, EstimateSchema) as Model<EstimateDocument>,
    Payment: model(Payment, PaymentSchema) as Model<PaymentDocument>,
    Refund: model(Refund, RefundSchema) as Model<RefundDocument>,
    Correction: model(Correction, CorrectionSchema) as Model<CorrectionDocument>,
    RevenueSnapshot: model(RevenueSnapshot, RevenueSnapshotSchema) as Model<RevenueSnapshotDocument>,
    ClinicalDocument: model(ClinicalDocument, ClinicalDocumentSchema) as Model<ClinicalDocumentDocument>,
    DischargePlan: model(DischargePlan, DischargePlanSchema) as Model<DischargePlanDocument>,
    DischargeOrder: model(DischargeOrder, DischargeOrderSchema) as Model<DischargeOrderDocument>,
    DischargeSummary: model(DischargeSummary, DischargeSummarySchema) as Model<DischargeSummaryDocument>,
    DischargeSnapshot: model(DischargeSnapshot, DischargeSnapshotSchema) as Model<DischargeSnapshotDocument>,
    QueueDisplay: model(QueueDisplay, QueueDisplaySchema) as Model<QueueDisplayDocument>,
    BillInvoice: model(BillInvoice, BillInvoiceSchema) as Model<BillInvoiceDocument>,
    ReceptionSession: model(ReceptionSession, ReceptionSessionSchema) as Model<ReceptionSessionDocument>,
    OtpChallenge: model(OtpChallenge, OtpChallengeSchema) as Model<OtpChallengeDocument>,
    OpVisit: model(OpVisit, OpVisitSchema) as Model<OpVisitDocument>,
    OpSequence: model(OpSequence, OpSequenceSchema) as Model<OpSequenceDocument>,
  };
}

/**
 * Connects to the test database and builds every model's indexes, which the specs
 * rely on (unique keys, one active admission per patient). syncIndexes builds them once, in place
 * of the background auto-build, and drops any an older schema left behind.
 */
export async function connectTestDb(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_TEST_URI ?? DEFAULT_URI;
  assertTestDatabase(databaseName(uri));
  await mongoose.connect(uri, { autoIndex: false });
  await Promise.all(Object.values(models()).map((m) => m.syncIndexes()));
  return mongoose;
}

/** Empties every collection, keeping the indexes. */
export async function resetTestDb(): Promise<void> {
  assertTestDatabase(mongoose.connection.name);
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function closeTestDb(): Promise<void> {
  await mongoose.disconnect();
}
