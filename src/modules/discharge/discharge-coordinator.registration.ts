import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import { escapeRegex } from '../../common/utils/escape-regex';
import { Admission, AdmissionDocument } from '../beds/schemas/admission.schema';
import { AgentRegistry } from '../coordinator/agent-registry';
import { CasesService } from '../coordinator/cases.service';
import { AgentDefinition, AgentStatusReport, ClockDef, CloseCheckResult, MessageTypeDef } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { COMPLETION_KINDS, CompletionKind, DEFAULT_DISCHARGE_CONFIG, KIND_LABEL } from './discharge-catalogue';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeOrder, DischargeOrderDocument, OPEN_ORDER_STATES } from './schemas/discharge-order.schema';
import { DischargePlan, DischargePlanDocument } from './schemas/discharge-plan.schema';

type Fields = MessageTypeDef['payload'];
const type = (t: string, description: string, payload: Fields): MessageTypeDef => ({ type: t, agent: 'discharge', description, payload });

/** Every field is required and non-null. Each message names the bed and the kind, never the patient. */
export const DISCHARGE_MESSAGE_TYPES: MessageTypeDef[] = [
  type('discharge.planned', 'A discharge target day was set or changed', { planId: 'string', admissionId: 'string', bedLabel: 'string', targetDay: 'string' }),
  type('discharge.ordered', 'A doctor ordered a discharge', {
    orderId: 'string', planId: 'string', admissionId: 'string', bedLabel: 'string', kind: 'string', plannedLeaveAt: 'date',
  }),
  // Sent when the window opens (A1): the clocks start on it, and their due times are real time. `summarySigned`:
  // the summary was signed before the window opened, so its clock does not start (R20).
  type('discharge.window-opened', 'The discharge window opened', {
    orderId: 'string', admissionId: 'string', bedLabel: 'string', kind: 'string', plannedLeaveAt: 'date', leaveDueAt: 'date', summaryDueAt: 'date',
    summarySigned: 'boolean',
  }),
  type('discharge.summary-signed', 'A discharge summary was signed', { orderId: 'string', summaryId: 'string', bedLabel: 'string', kind: 'string' }),
  type('discharge.ready', 'Every required discharge line is done', { orderId: 'string', bedLabel: 'string', kind: 'string' }),
  // `orderId` is '' for a patient who left without discharge before any order was given.
  type('discharge.completed', 'The inpatient stay ended', {
    planId: 'string', orderId: 'string', admissionId: 'string', bedLabel: 'string', kind: 'string', leftAt: 'date',
  }),
  // The reason stays on the order, never in a message.
  type('discharge.cancelled', 'A discharge order was cancelled', { orderId: 'string', admissionId: 'string', bedLabel: 'string' }),
];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const date = (key: string) => (payload: Record<string, unknown>): Date | null => {
  const v = payload[key];
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};
const byOrder = (_t: string, p: Record<string, unknown>) => str(p.orderId);
const isKind = (v: string | null): v is CompletionKind => !!v && (COMPLETION_KINDS as readonly string[]).includes(v);

/** "GWA-12 (Home)": what an escalation is about (A4), fixed when the clock starts. Never a name. */
const bedAndKind = (p: Record<string, unknown>): string | null => {
  const bed = str(p.bedLabel);
  if (!bed) return null;
  const kind = str(p.kind);
  return isKind(kind) ? `${bed} (${KIND_LABEL[kind]})` : bed;
};

/**
 * Exported for the demo seed. The minutes are the defaults: the sender computes `leaveDueAt` and `summaryDueAt`
 * from Settings → Discharge when the window opens, and says whether the summary is already signed. Start and stop
 * messages must carry the same case and order id.
 */
export const DISCHARGE_CLOCKS: ClockDef[] = [
  {
    key: 'discharge-leave',
    agent: 'discharge',
    label: 'Order to leaving',
    startOn: 'discharge.window-opened',
    stopOn: ['discharge.completed', 'discharge.cancelled'],
    minutes: DEFAULT_DISCHARGE_CONFIG.leaveMinutes,
    ladder: 'discharge',
    dueFrom: date('leaveDueAt'),
    refFrom: byOrder,
    resolveEscalationOnStop: true,
    resolvedBy: 'Discharge Agent',
    alertLink: (ref) => (ref ? `discharge-order:${ref}` : null),
    detailFrom: bedAndKind,
  },
  {
    key: 'discharge-summary',
    agent: 'discharge',
    label: 'Summary signed',
    startOn: 'discharge.window-opened',
    stopOn: ['discharge.summary-signed', 'discharge.completed', 'discharge.cancelled'],
    // A summary signed before the window opened sent its stop before this clock could start, and a stop that
    // comes first is not kept: a window that opens on a signed summary starts no clock. Every stop still matches.
    match: (type, payload) => type !== 'discharge.window-opened' || payload.summarySigned !== true,
    minutes: DEFAULT_DISCHARGE_CONFIG.summaryMinutes,
    ladder: 'discharge-doctor',
    dueFrom: date('summaryDueAt'),
    refFrom: byOrder,
    resolveEscalationOnStop: true,
    resolvedBy: 'Discharge Agent',
    alertLink: (ref) => (ref ? `discharge-order:${ref}:summary` : null),
    detailFrom: bedAndKind,
  },
];

/** The other agents' messages that wake the Discharge Agent. Each only wakes it; the handler re-reads the records. */
export const WAKE_TYPES = [
  'bed.assigned',
  'bed.transferred',
  'bed.discharged',
  'lab.resulted',
  'lab.cancelled',
  'lab.critical',
  'lab.critical-acked',
  'pharmacy.issued',
  'pharmacy.cancelled',
  'pharmacy.stopped',
  'pharmacy.rejected',
  'scheduling.followup-booked',
  'revenue.bill-final',
  'revenue.bill-settled',
] as const;

const MINUTE_MS = 60_000;

/** True when the summary holds the whole name as words of its own, in any letter case or spacing. */
function namesPatient(summary: string, name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const pattern = words.map((w) => escapeRegex(w)).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${pattern}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').test(summary);
}

/** Tells the Coordinator what the Discharge agent sends, and the clocks, rules and close check it brings. */
@Injectable()
export class DischargeRegistration implements OnModuleInit {
  private readonly logger = new Logger(DischargeRegistration.name);

  /** Message handlers by type, set by the services that react (later tasks), so this file need not import them. A type with none does nothing. */
  readonly wake = new Map<string, (messageId: string) => Promise<void>>();

  /** The clinic clock, for "today" in the status; a spec replaces it. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly messages: MessagesService,
    private readonly cases: CasesService,
    private readonly settings: DischargeSettingsService,
    @InjectModel(DischargePlan.name) private readonly plans: Model<DischargePlanDocument>,
    @InjectModel(DischargeOrder.name) private readonly orders: Model<DischargeOrderDocument>,
    @InjectModel(Admission.name) private readonly admissions: Model<AdmissionDocument>,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
  }

  /**
   * Sends a Discharge message to the Coordinator, on the case when there is one. Callers write the summary as
   * "<bedLabel>: <what happened> (<Kind>)": no patient name, at most 140 characters (the Coordinator clips a
   * longer one). As a safety net, a summary holding the case's patient name is not sent; with no case it cannot
   * be checked, so callers must keep names out. Never throws. True when the message went, or the same one went
   * within the last minute (the Coordinator drops the repeat); false, with a warning, when it was not sent.
   */
  async send(type: string, caseId: string | null, payload: Record<string, unknown>, summary: string): Promise<boolean> {
    try {
      const patientName = caseId ? (await this.cases.get(caseId))?.patientName : null;
      if (patientName && namesPatient(summary, patientName)) {
        this.logger.warn(`${type} not sent: its summary names the patient (case ${caseId})`);
        return false;
      }
      await this.messages.send({ case: caseId, from: 'discharge', to: ['coordinator'], type, priority: 'medium', summary, payload });
      return true;
    } catch (e) {
      this.logger.warn(`${type} not sent${caseId ? ` (case ${caseId})` : ''}: ${(e as Error).message}`);
      return false;
    }
  }

  private definition(): AgentDefinition {
    return {
      key: 'discharge',
      messageTypes: DISCHARGE_MESSAGE_TYPES,
      clocks: DISCHARGE_CLOCKS,
      handles: WAKE_TYPES.map((t) => ({ type: t, handler: (id: string) => this.wakeOn(t, id) })),
      rules: [
        {
          key: 'discharge-dependency-checks',
          agent: 'discharge',
          label: "Never discharge without a doctor's order",
          description: "Every real discharge goes through the doctor's order and its checklist.",
          default: true,
          locked: true,
        },
        {
          // No settingPath: a path into the discharge section would not save (updateSettings strips it), so the
          // switch lives in settings.coordinator.rules.
          key: 'discharge-morning-reminder',
          agent: 'discharge',
          label: 'Remind the doctor on the target day',
          description: "At the reminder time on the target day, the admission's doctor gets a task when there is no discharge order yet.",
          default: true,
        },
      ],
      closeChecks: [{ agent: 'discharge', label: 'Discharge complete', check: (caseId) => this.closeCheck(caseId) }],
      status: () => this.status(),
    };
  }

  /** Runs the handler a later task set for the type, if any. Nothing escapes: the one-minute pass repairs what a failure missed. */
  private async wakeOn(type: string, messageId: string): Promise<void> {
    const handler = this.wake.get(type);
    if (!handler) return;
    try {
      await handler(messageId);
    } catch (e) {
      this.logger.error(`${type} (message ${messageId}) failed: ${(e as Error).message}`);
    }
  }

  /**
   * "Discharge complete" (ruling R18). 'n/a' when the case has no admission, or a sample one; 'pass' once the
   * admission's plan is completed, or the admission itself is discharged (a stay that ended before this agent,
   * or by the old route, must not hold its case open); 'fail' otherwise.
   */
  private async closeCheck(caseId: string): Promise<CloseCheckResult> {
    const admissionId = (await this.cases.get(caseId))?.refs?.admissionId;
    if (!admissionId || !Types.ObjectId.isValid(admissionId)) return 'n/a';
    const admission = await this.admissions.findById(admissionId).select('status sample').lean<{ status: string; sample?: boolean }>().exec();
    if (admission?.sample) return 'n/a';
    if (admission?.status === 'discharged') return 'pass';
    const plan = await this.plans.findOne({ admission: new Types.ObjectId(admissionId) }).select('state').lean<{ state: string }>().exec();
    return plan?.state === 'completed' ? 'pass' : 'fail';
  }

  /**
   * A5: the orders in progress; no fixed capacity; and of the orders that left today (clinic day), the share
   * that left within the target of their window's start (null when none has left today).
   */
  private async status(): Promise<AgentStatusReport> {
    const now = this.clock();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const [open, left, config] = await Promise.all([
      this.orders.countDocuments({ state: { $in: OPEN_ORDER_STATES } }).exec(),
      this.orders
        .find({ state: 'left', leftAt: { $gte: dayStart, $lt: dayEnd } })
        .select('windowAt leftAt')
        .lean<{ windowAt: Date; leftAt: Date }[]>()
        .exec(),
      this.settings.get(),
    ]);
    const target = config.leaveMinutes * MINUTE_MS;
    const onTime = left.filter((o) => new Date(o.leftAt).getTime() - new Date(o.windowAt).getTime() <= target).length;
    return { open, capacity: null, onTimePct: left.length ? Math.round((onTime / left.length) * 100) : null };
  }
}
