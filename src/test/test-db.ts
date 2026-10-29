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
import { ErExpected, ErExpectedDocument, ErExpectedSchema } from '../modules/er/schemas/er-expected.schema';
import { PatientCard, PatientCardDocument, PatientCardSchema } from '../modules/queue/schemas/patient-card.schema';
import { User, UserDocument, UserSchema } from '../modules/users/schemas/user.schema';

// Database specs share one throwaway database. The name check stops a stray
// MONGODB_TEST_URI from wiping a real one (medios_hospital, medios_beds_dev).

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
    ErExpected: model(ErExpected, ErExpectedSchema) as Model<ErExpectedDocument>,
    PatientCard: model(PatientCard, PatientCardSchema) as Model<PatientCardDocument>,
    User: model(User, UserSchema) as Model<UserDocument>,
    HospitalSettings: model(HospitalSettings, HospitalSettingsSchema) as Model<HospitalSettingsDocument>,
  };
}

/**
 * Connects to the test database and builds every model's indexes, which the specs
 * rely on (one active admission per patient). syncIndexes builds them once, in place
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
