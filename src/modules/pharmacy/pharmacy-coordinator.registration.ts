import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, ClockDef, MessageTypeDef } from '../coordinator/coordinator-types';
import { MessagesService, MessageView } from '../coordinator/messages.service';
import { Clock, ClockDocument } from '../coordinator/schemas/clock.schema';
import type { CompletionKind } from '../discharge/discharge-catalogue';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';
import { PharmacyOrder, PharmacyOrderDocument } from './schemas/pharmacy-order.schema';
import { medicineLabel } from './pharmacy-rounds';
import { PharmacyChecksService, WAITING } from './pharmacy-checks.service';
import { PharmacyOrdersService } from './pharmacy-orders.service';
import { PharmacyProceduresService } from './pharmacy-procedures.service';
import { DISCHARGE_AGENT_ACTOR } from './pharmacy-take-home.service';

type Fields = MessageTypeDef['payload'];

const type = (t: string, description: string, payload: Fields): MessageTypeDef => ({ type: t, agent: 'pharmacy', description, payload });

/** The fields every line message carries. */
const LINE: Fields = {
  orderId: 'string',
  orderNumber: 'string',
  lineId: 'string',
  medicine: 'string',
  priority: 'string',
  setting: 'string',
  version: 'number',
  checkRound: 'number',
  checkDueAt: 'date',
  issueRound: 'number',
  issueDueAt: 'date',
};

const MESSAGE_TYPES: MessageTypeDef[] = [
  type('pharmacy.ordered', 'Medicines were ordered', { orderId: 'string', orderNumber: 'string', priority: 'string', setting: 'string', source: 'string', medicines: 'string[]' }),
  type('pharmacy.to-check', 'A medicine line is waiting for the pharmacist to check', LINE),
  type('pharmacy.approved', 'A pharmacist approved a medicine line', LINE),
  type('pharmacy.to-issue', 'A medicine line is waiting to be issued', LINE),
  type('pharmacy.query', 'A pharmacist asked the doctor about a medicine line', { ...LINE, querySeq: 'number', kind: 'string', queryDueAt: 'date' }),
  type('pharmacy.query-answered', 'A doctor answered a query about a medicine line', { ...LINE, querySeq: 'number', outcome: 'string' }),
  type('pharmacy.rejected', 'A pharmacist rejected a medicine line', LINE),
  type('pharmacy.issued', 'A medicine line was issued from stock', { ...LINE, store: 'string', quantity: 'number' }),
  type('pharmacy.cancelled', 'A medicine line was cancelled', { ...LINE, querySeq: 'number' }),
  type('pharmacy.stopped', 'An issued medicine line was stopped', { ...LINE, querySeq: 'number' }),
  type('pharmacy.check-done', 'Every medicine line of an order is checked', { orderId: 'string', orderNumber: 'string', checkRound: 'number' }),
  type('pharmacy.issue-done', 'Every approved medicine line of an order is issued', { orderId: 'string', orderNumber: 'string', issueRound: 'number' }),
];

export const PHARMACY_MESSAGE_TYPES = MESSAGE_TYPES;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const date = (key: string) => (payload: Record<string, unknown>): Date | null => {
  const v = payload[key];
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

/** A round's clock ref carries the round number, so a message about an older round never reaches a newer clock. */
const roundRef = (letter: 'c' | 'i', round: string) => (_t: string, p: Record<string, unknown>): string | null => {
  const order = str(p.orderId);
  const n = num(p[round]);
  return order && n !== null ? `${order}:${letter}${n}` : null;
};
const queryRef = (_t: string, p: Record<string, unknown>): string | null => {
  const line = str(p.lineId);
  const n = num(p.querySeq);
  return line && n !== null ? `${line}:q${n}` : null;
};

/** "MO-0001 · Enoxaparin": what an escalation is about, never a name. */
const lineDetail = (p: Record<string, unknown>): string | null => {
  const number = str(p.orderNumber);
  const medicine = str(p.medicine);
  return number && medicine ? `${number} · ${medicineLabel(medicine === 'unlisted' ? null : medicine)}` : number;
};

/** The messages that move a running clock to the due time they carry. */
const LINE_TYPES = [
  'pharmacy.to-check',
  'pharmacy.approved',
  'pharmacy.to-issue',
  'pharmacy.query',
  'pharmacy.query-answered',
  'pharmacy.rejected',
  'pharmacy.issued',
  'pharmacy.cancelled',
  'pharmacy.stopped',
];

/** Exported for the demo seed, so seeded clocks carry the same detail the live ones do. */
export const PHARMACY_CLOCKS: ClockDef[] = [
  {
    key: 'pharmacy-check',
    agent: 'pharmacy',
    label: 'Medicine check',
    startOn: 'pharmacy.to-check',
    stopOn: ['pharmacy.check-done'],
    minutes: 240,
    ladder: 'pharmacy',
    dueFrom: date('checkDueAt'),
    refFrom: roundRef('c', 'checkRound'),
    updateOn: LINE_TYPES,
    detailFrom: lineDetail,
  },
  {
    key: 'pharmacy-issue',
    agent: 'pharmacy',
    label: 'Medicine issue',
    startOn: 'pharmacy.to-issue',
    stopOn: ['pharmacy.issue-done'],
    minutes: 240,
    ladder: 'pharmacy',
    // An OPD patient collects at the counter: no issue clock.
    match: (_t, p) => p.setting !== 'OPD',
    dueFrom: date('issueDueAt'),
    refFrom: roundRef('i', 'issueRound'),
    updateOn: LINE_TYPES,
    detailFrom: lineDetail,
  },
  {
    key: 'pharmacy-query',
    agent: 'pharmacy',
    label: 'Pharmacy query answer',
    startOn: 'pharmacy.query',
    stopOn: ['pharmacy.query-answered', 'pharmacy.cancelled', 'pharmacy.stopped'],
    minutes: 120,
    ladder: 'pharmacy-query',
    dueFrom: date('queryDueAt'),
    refFrom: queryRef,
    // One answer path: the query itself. Its escalation rides on the line's alert and closes with the answer.
    resolveEscalationOnStop: true,
    resolvedBy: 'Query answered',
    alertLink: (ref) => (ref ? `pharmacy-line:${ref.split(':')[0]}` : null),
    detailFrom: (p) => {
      const base = lineDetail(p);
      const kind = str(p.kind);
      return base && kind ? `${base} · ${kind}` : base;
    },
  },
];

/** A line with a question the doctor has not answered, whether the line waits to be checked, was approved, or was already issued. */
export const OPEN_QUERY_FILTER = {
  status: { $in: ['to-check', 'query', 'approved', 'issued'] },
  query: { $exists: true },
  'query.answer': { $exists: false },
} as const;

/** The share of Medicine check clocks stopped since `since` that were met in time; null when none stopped. */
export async function pharmacyOnTimePct(clocks: Model<ClockDocument>, since: Date): Promise<number | null> {
  const stopped = await clocks.find({ def: 'pharmacy-check', stoppedAt: { $gte: since } }).select('state').lean<{ state: string }[]>().exec();
  if (!stopped.length) return null;
  return Math.round((stopped.filter((c) => c.state === 'met').length / stopped.length) * 100);
}

/** The cancel reason for each way a patient leaves. */
const LEFT_REASON: Record<CompletionKind, string> = {
  home: 'Patient discharged',
  transfer: 'Patient discharged',
  'against-advice': 'Patient discharged',
  died: 'Patient died',
  'left-without-discharge': 'Patient left without discharge',
};

/** Tells the Coordinator what the Pharmacy agent sends, and the clocks and rule it brings. */
@Injectable()
export class PharmacyCoordinatorRegistration implements OnModuleInit {
  private readonly logger = new Logger(PharmacyCoordinatorRegistration.name);

  constructor(
    private readonly registry: AgentRegistry,
    private readonly orders: PharmacyOrdersService,
    private readonly messages: MessagesService,
    private readonly checks: PharmacyChecksService,
    @InjectModel(PharmacyOrder.name) private readonly orderDocs: Model<PharmacyOrderDocument>,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    @InjectModel(Clock.name) private readonly clocks: Model<ClockDocument>,
    private readonly procedures: PharmacyProceduresService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
  }

  private definition(): AgentDefinition {
    return {
      key: 'pharmacy',
      messageTypes: MESSAGE_TYPES,
      clocks: PHARMACY_CLOCKS,
      handles: [
        // A released kidney test re-checks the doses that depend on it.
        { type: 'lab.resulted', handler: (id) => this.checks.onKidneyResult(id) },
        { type: 'er.arrived', handler: (id) => this.locate(id, () => ({ area: 'ER' })) },
        { type: 'bed.assigned', handler: (id) => this.locate(id, (p) => ({ area: 'Ward', ward: str(p.ward) ?? undefined })) },
        { type: 'bed.transferred', handler: (id) => this.locate(id, (p) => ({ area: 'Ward', ward: str(p.ward) ?? undefined })) },
        // Leaving the ER for a bed is not a move home: bed.assigned places the patient.
        { type: 'er.left', handler: (id) => this.locate(id, (p) => (p.reason === 'admitted' ? null : { area: 'OPD' })) },
        { type: 'bed.discharged', handler: (id) => this.locate(id, () => ({ area: 'OPD' })) },
        // Scheduling's procedures: contrast dye with metformin, and dual antiplatelet medicines after a stent.
        { type: 'scheduling.procedure-booked', handler: (id) => this.procedures.onBooked(id) },
        { type: 'scheduling.procedure-cancelled', handler: (id) => this.procedures.onCancelled(id) },
        { type: 'scheduling.procedure-bumped', handler: (id) => this.procedures.onCancelled(id) },
        { type: 'scheduling.procedure-done', handler: (id) => this.procedures.onDone(id) },
        // Leaving (A12): Pharmacy itself ends the lines still waiting. OPD counter lines are never touched.
        { type: 'discharge.completed', handler: (id) => this.onLeft(id) },
        { type: 'discharge.cancelled', handler: (id) => this.onDischargeCancelled(id) },
      ],
      rules: [
        {
          key: 'medicine-safety-checks',
          agent: 'pharmacy',
          label: 'Medicine safety checks',
          description: 'Check every medicine order for allergy, clashes, doubles, dose and kidney function',
          default: true,
          locked: true,
        },
      ],
      closeChecks: [{ agent: 'pharmacy', label: 'Medicine orders checked', check: (caseId) => this.closeCheck(caseId) }],
      status: async () => ({
        open: await this.lines
          .countDocuments({ $or: [{ status: { $in: ['to-check', 'approved'] } }, OPEN_QUERY_FILTER as never] })
          .exec(),
        capacity: 0,
        onTimePct: await pharmacyOnTimePct(this.clocks, new Date(Date.now() - 24 * 3_600_000)),
      }),
    };
  }

  private async locate(
    messageId: string,
    where: (payload: Record<string, unknown>) => { area: 'ER' | 'Ward' | 'OPD'; ward?: string } | null,
  ): Promise<void> {
    const message = await this.messages.get(messageId);
    if (!message?.case) return;
    const w = where(message.payload ?? {});
    if (w) await this.orders.setLocation(message.case, w.area, w.ward);
  }

  /** The patient left (any kind): every waiting line of the case's ER and Ward orders, take-home included, is cancelled. */
  private onLeft(messageId: string): Promise<void> {
    return this.quietly('discharge.completed', messageId, async (message) => {
      const kind = str(message.payload?.kind);
      const reason = kind && Object.prototype.hasOwnProperty.call(LEFT_REASON, kind) ? LEFT_REASON[kind as CompletionKind] : LEFT_REASON.home;
      await this.cancelWaitingOn(message, { setting: { $in: ['ER', 'Ward'] } }, reason);
    });
  }

  /** A discharge order was cancelled: only the waiting lines of the case's take-home orders are cancelled. */
  private onDischargeCancelled(messageId: string): Promise<void> {
    return this.quietly('discharge.cancelled', messageId, (message) => this.cancelWaitingOn(message, { takeHome: true }, 'Discharge cancelled'));
  }

  /**
   * Cancels the waiting lines of the case's orders that match, as the Discharge Agent. Only lines that existed when the
   * message was sent: a late re-run never reaches lines ordered after it. Lines already closed are skipped, so a re-run cancels nothing twice.
   */
  private async cancelWaitingOn(message: MessageView, orderFilter: Record<string, unknown>, reason: string): Promise<void> {
    const orders = await this.orderDocs.find({ case: message.case, ...orderFilter }).select('_id').lean<{ _id: unknown }[]>().exec();
    if (!orders.length) return;
    const waiting = await this.lines
      .find({ order: { $in: orders.map((o) => o._id) }, status: { $in: WAITING }, createdAt: { $lte: new Date(message.createdAt) } })
      .sort({ _id: 1 })
      .select('_id')
      .lean<{ _id: unknown }[]>()
      .exec();
    await this.checks.cancelWaiting(DISCHARGE_AGENT_ACTOR, waiting.map((l) => String(l._id)), reason);
  }

  /** Loads the message (one with no case is ignored) and runs the step; it never throws, so a failure is only logged. */
  private async quietly(type: string, messageId: string, step: (message: MessageView & { case: string }) => Promise<void>): Promise<void> {
    try {
      const message = await this.messages.get(messageId);
      if (!message?.case) return;
      await step(message as MessageView & { case: string });
    } catch (e) {
      this.logger.error(`Handling ${type} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 'n/a' with no lines on the case. 'fail' while a line waits for its check, has an open query, or is approved
   * but not issued in the ER or a ward (including waiting for stock). Approved OPD lines wait at the counter and don't block.
   */
  private async closeCheck(caseId: string): Promise<'pass' | 'fail' | 'n/a'> {
    const orders = await this.orderDocs.find({ case: caseId }).select('_id setting').lean<{ _id: unknown; setting: string }[]>().exec();
    const lines = await this.lines.find({ order: { $in: orders.map((o) => o._id) } }).select('order status query').lean<{ order: unknown; status: string; query?: { answer?: unknown } }[]>().exec();
    if (!lines.length) return 'n/a';
    const opd = new Set(orders.filter((o) => o.setting === 'OPD').map((o) => String(o._id)));
    const blocked = lines.some(
      (l) =>
        l.status === 'to-check' ||
        (['query', 'approved', 'issued'].includes(l.status) && l.query && !l.query.answer) ||
        (l.status === 'approved' && !opd.has(String(l.order))),
    );
    return blocked ? 'fail' : 'pass';
  }
}
