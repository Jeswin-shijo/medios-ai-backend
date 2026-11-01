import { Types } from 'mongoose';
import { models } from './test-db';
import { Actor } from '../modules/beds/actor';
import { AgentRegistry } from '../modules/coordinator/agent-registry';
import { CasesService } from '../modules/coordinator/cases.service';
import { ClocksService } from '../modules/coordinator/clocks.service';
import { CoordinatorEvents } from '../modules/coordinator/coordinator-events';
import { EscalationsService } from '../modules/coordinator/escalations.service';
import { MessagesService } from '../modules/coordinator/messages.service';
import { PatientsService } from '../modules/patients/patients.service';
import { SettingsService } from '../modules/settings/settings.service';
import { TimelineService } from '../modules/timeline/timeline.service';
import { UserRole } from '../modules/users/schemas/user.schema';
import { PharmacyChecksService } from '../modules/pharmacy/pharmacy-checks.service';
import { PharmacyCoordinatorRegistration } from '../modules/pharmacy/pharmacy-coordinator.registration';
import { LineInput, PharmacyOrdersService } from '../modules/pharmacy/pharmacy-orders.service';
import { PharmacyProceduresService } from '../modules/pharmacy/pharmacy-procedures.service';
import { PharmacyPatientsService } from '../modules/pharmacy/pharmacy-patients.service';
import { PharmacySettingsService } from '../modules/pharmacy/pharmacy-settings.service';

export const DOC: Actor = { id: 'user-doc', name: 'Dr. Shajin', role: UserRole.DOCTOR };
export const PHARM: Actor = { id: 'user-ph', name: 'Neethu George', role: UserRole.PHARMACIST };
export const MIN = 60_000;

export const aspirin300: LineInput = { medicine: 'aspirin', product: 'aspirin-tab-300', dose: 300, route: 'oral', frequency: 'STAT' };
export const clopidogrel300: LineInput = { medicine: 'clopidogrel', product: 'clopidogrel-tab-75', dose: 300, route: 'oral', frequency: 'STAT' };
export const enoxaparin60: LineInput = { medicine: 'enoxaparin', product: 'enoxaparin-syringe-60', dose: 60, route: 'sc', frequency: 'BD', durationDays: 5 };
export const ibuprofen400: LineInput = { medicine: 'ibuprofen', product: 'ibuprofen-tab-400', dose: 400, route: 'oral', frequency: 'STAT' };
export const amoxicillin500: LineInput = { medicine: 'amoxicillin', product: 'amoxicillin-cap-500', dose: 500, route: 'oral', frequency: 'TDS', durationDays: 5 };
export const ceftriaxone1: LineInput = { medicine: 'ceftriaxone', product: 'ceftriaxone-vial-1', dose: 1, route: 'iv', frequency: 'STAT' };

/** The pharmacy agent wired to a test database, with a stub Lab agent that can send lab.resulted. */
export async function buildWorld(m: ReturnType<typeof models>, opts: { stubClose?: boolean } = {}) {
  const registry = new AgentRegistry();
  const events = new CoordinatorEvents();
  const messages = new MessagesService(m.AgentMessage, registry, events);
  const escalations = new EscalationsService(m.Escalation, m.DutyTitle, m.Ladder, m.TaskAlertItem, m.User, messages, events);
  await escalations.ensureDefaults();
  const clocks = new ClocksService(m.Clock, registry, messages, escalations);
  const cases = new CasesService(m.Case, m.CoordinatorCounter, messages, registry, new TimelineService(m.TimelineEvent));
  const settings = new PharmacySettingsService(new SettingsService(m.HospitalSettings));
  const orders = new PharmacyOrdersService(
    m.PharmacyOrder, m.PharmacyLine, m.PharmacyLocation, m.CoordinatorCounter,
    new PatientsService(m.Patient), cases, messages, settings, new PharmacyPatientsService(m.Patient, m.LabTestReport, m.PharmacyProcedureNote),
  );
  const checks = new PharmacyChecksService(m.PharmacyLine, m.PharmacyOrder, m.TaskAlertItem, orders, cases, messages, settings);
  new PharmacyCoordinatorRegistration(registry, orders, messages, checks, m.PharmacyOrder, m.PharmacyLine, m.Clock, new PharmacyProceduresService(m.PharmacyProcedureNote, m.PharmacyLine, m.PharmacyOrder, m.TaskAlertItem, orders, cases, messages, new PharmacyPatientsService(m.Patient, m.LabTestReport, m.PharmacyProcedureNote))).onModuleInit();
  registry.register({
    key: 'lab',
    messageTypes: [{ type: 'lab.resulted', agent: 'lab', description: 'x', payload: { test: 'string' } }],
    // Keeps every case open, so a test's second order joins the same ER case (the pharmacy close check passes once nothing waits to be checked).
    closeChecks: opts.stubClose === false ? [] : [{ agent: 'lab', label: 'Keeps the test case open', check: async () => 'fail' as const }],
    status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
  });
  const p = await m.Patient.create({ uhid: 'MHK202600901', name: 'Ravi Kumar', age: 62, gender: 'Male', phone: '9100000001', vitals: { weightKg: 64 } });
  const patientId = String(p._id);
  const patientUhid = p.uhid;
  const w = {
    registry, messages, escalations, clocks, cases, orders, checks, patientId, patientUhid,
    sent: (type: string) => m.AgentMessage.find({ type }).sort({ createdAt: 1, _id: 1 }).lean().exec() as Promise<any[]>,
    clocksOf: (def: string) => m.Clock.find({ def }).sort({ startedAt: 1 }).lean().exec() as Promise<any[]>,
    openEr: () => cases.openOrJoin({ patientId, patientUhid, patientName: 'Ravi Kumar', kind: 'er', priority: 'high', openedBy: 'er' }),
    lineDoc: (id: string) => m.PharmacyLine.findById(id).lean().exec() as Promise<any>,
    /** Sets up the state directly: an unconfirmed red allergy flag on a line (the order path refuses to create one). */
    redAllergy: (id: string, medicine = 'amoxicillin') =>
      m.PharmacyLine.updateOne(
        { _id: id },
        { $push: { flags: { key: `allergy.${medicine}`, kind: 'allergy', severity: 'red', text: `Allergy recorded to ${medicine}`, version: 1 } } },
      ),
    kidneyReport: (creatinine: number, extra: Record<string, unknown> = {}) =>
      m.LabTestReport.create({
        uhid: patientUhid,
        testName: 'Kidney function',
        category: 'Biochemistry',
        groups: [{ category: 'Kidney function', parameters: [{ name: 'Creatinine', result: creatinine, referenceRange: '0.7-1.3', unit: 'mg/dL', status: 'High' }] }],
        ...extra,
      }),
    labResulted: (caseId: string, test: string) =>
      messages.send({
        case: caseId, from: 'lab', to: ['coordinator'], type: 'lab.resulted', priority: 'high', summary: 'x',
        payload: { test }, dedupeKey: `lab.resulted:${new Types.ObjectId()}`,
      }),
  };
  return w;
}
export type World = Awaited<ReturnType<typeof buildWorld>>;
