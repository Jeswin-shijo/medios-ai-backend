import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { formatRupees } from '../../common/utils/money';
import type { Actor } from '../beds/actor';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, ClockDef, MessageTypeDef, Priority } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_CLOCKS } from './revenue-catalogue';
import { Bill, BillDocument } from './schemas/bill.schema';
import { Refund, RefundDocument } from './schemas/refund.schema';

type Fields = MessageTypeDef['payload'];
const type = (t: string, description: string, payload: Fields): MessageTypeDef => ({ type: t, agent: 'revenue', description, payload });

const BILL: Fields = { billId: 'string', billNumber: 'string' };
const REFUND: Fields = { refundId: 'string', refundNumber: 'string', billNumber: 'string' };

export const REVENUE_MESSAGE_TYPES: MessageTypeDef[] = [
  type('revenue.estimate-ready', 'An estimate for the stay is ready', { ...BILL, low: 'number', high: 'number' }),
  type('revenue.deposit-due', 'An advance should be collected', { ...BILL, amount: 'number' }),
  type('revenue.topup-due', 'The advance is nearly used up; a top-up is due', { ...BILL, amount: 'number', dueAt: 'date' }),
  type('revenue.topup-met', 'The top-up was paid', BILL),
  type('revenue.payment', 'A payment was received', { ...BILL, receiptNumber: 'string', amount: 'number', mode: 'string' }),
  type('revenue.final-requested', 'The final bill must be prepared', { ...BILL, dueAt: 'date' }),
  type('revenue.bill-final', 'The final bill is ready', { ...BILL, balance: 'number' }),
  type('revenue.bill-settled', 'The bill is settled', { ...BILL, total: 'number' }),
  type('revenue.refund-due', 'A refund is owed to the patient', { ...REFUND, amount: 'number', dueAt: 'date' }),
  type('revenue.refund-paid', 'A refund was paid', REFUND),
  type('revenue.refund-void', 'A refund is no longer owed', REFUND),
];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const dueAt = (payload: Record<string, unknown>): Date | null => {
  const v = payload.dueAt;
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

/** Exported for the demo seed. The minutes are the defaults: senders compute `dueAt` from Settings → Revenue. */
export const REVENUE_CLOCKS: ClockDef[] = [
  {
    key: 'revenue-final',
    agent: 'revenue',
    label: 'Final bill prepared',
    startOn: 'revenue.final-requested',
    stopOn: ['revenue.bill-final', 'revenue.bill-settled'],
    minutes: DEFAULT_CLOCKS.final,
    ladder: 'revenue',
    dueFrom: dueAt,
    refFrom: (_t, p) => str(p.billId),
    resolveEscalationOnStop: true,
    resolvedBy: 'Final bill ready',
    alertLink: (ref) => (ref ? `revenue-bill:${ref}:final` : null),
    detailFrom: (p) => str(p.billNumber),
  },
  {
    key: 'revenue-topup',
    agent: 'revenue',
    label: 'Top-up collected',
    startOn: 'revenue.topup-due',
    stopOn: ['revenue.topup-met', 'revenue.bill-settled'],
    minutes: DEFAULT_CLOCKS.topup,
    ladder: 'revenue',
    dueFrom: dueAt,
    refFrom: (_t, p) => str(p.billId),
    resolveEscalationOnStop: true,
    resolvedBy: 'Top-up met',
    alertLink: (ref) => (ref ? `revenue-bill:${ref}:topup` : null),
    detailFrom: (p) => str(p.billNumber),
  },
  {
    key: 'revenue-refund',
    agent: 'revenue',
    label: 'Refund paid',
    startOn: 'revenue.refund-due',
    stopOn: ['revenue.refund-paid', 'revenue.refund-void'],
    minutes: DEFAULT_CLOCKS.refund,
    ladder: 'revenue',
    dueFrom: dueAt,
    refFrom: (_t, p) => str(p.refundId),
    resolveEscalationOnStop: true,
    resolvedBy: 'Refund paid',
    alertLink: (ref) => (ref ? `revenue-refund:${ref}` : null),
    detailFrom: (p) => str(p.refundNumber),
  },
];

/** The messages whose charges Revenue collects itself (bed days included). The handler for each is set by RevenueCaptureService. */
export const CAPTURE_TYPES = [
  'er.arrived',
  'er.doctor-seen',
  'lab.collected',
  'lab.cancelled',
  'pharmacy.issued',
  'scheduling.procedure-done',
  'scheduling.procedure-booked',
  'scheduling.consult-seen',
  'bed.assigned',
  'bed.transferred',
  'bed.discharged',
  'er.left',
] as const;

export type ApprovalListener = (approvalId: string, decision: 'approved' | 'rejected', actor: Actor) => Promise<void>;

const OPEN_TASK_LINK = /^revenue-bill:[^:]+:(deposit|topup)$/;

/** Tells the Coordinator what the Revenue agent sends, and the clocks, rules, approvals and close check it brings. */
@Injectable()
export class RevenueCoordinatorRegistration implements OnModuleInit {
  /** Task 10 (corrections) and Task 9 (refunds) register here, so the services need not import each other. Awaited in order; a throw reopens the approval. */
  readonly onCorrectionDecision: ApprovalListener[] = [];
  readonly onRefundDecision: ApprovalListener[] = [];
  /** Message handlers by type, set by the capture service (and later tasks) so this file need not import them. A type with none does nothing. */
  readonly capture = new Map<string, (messageId: string) => Promise<void>>();

  constructor(
    private readonly registry: AgentRegistry,
    @InjectModel(Bill.name) private readonly bills: Model<BillDocument>,
    @InjectModel(Refund.name) private readonly refunds: Model<RefundDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly messages: MessagesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
  }

  /**
   * Sends a Revenue message to the Coordinator. The summary is "<BL-0001>: <text> (₹<amount>)": no patient name,
   * 140 characters at most. The message joins the bill's case, if it has one.
   */
  send(
    messageType: string,
    bill: { number: string; case?: unknown } | null,
    payload: Record<string, unknown>,
    extra: { text: string; amount?: number; dedupeKey?: string; priority?: Priority },
  ) {
    const prefix = bill ? `${bill.number}: ` : '';
    const amount = extra.amount === undefined ? '' : ` (${formatRupees(extra.amount)})`;
    const room = Math.max(0, 140 - prefix.length - amount.length);
    return this.messages.send({
      case: bill?.case ? String(bill.case) : null,
      from: 'revenue',
      to: ['coordinator'],
      type: messageType,
      priority: extra.priority ?? 'medium',
      summary: `${prefix}${extra.text.slice(0, room)}${amount}`,
      payload,
      ...(extra.dedupeKey ? { dedupeKey: extra.dedupeKey } : {}),
    });
  }

  private definition(): AgentDefinition {
    const decide = (listeners: ApprovalListener[]): ApprovalListener => async (id, decision, actor) => {
      for (const listener of listeners) await listener(id, decision, actor);
    };
    return {
      key: 'revenue',
      messageTypes: REVENUE_MESSAGE_TYPES,
      clocks: REVENUE_CLOCKS,
      handles: CAPTURE_TYPES.map((t) => ({ type: t, handler: async (id: string) => { await this.capture.get(t)?.(id); } })),
      approvalTypes: [
        { type: 'revenue.correction', agent: 'revenue', roles: [UserRole.ADMIN], primary: { kind: 'approve', label: 'Approve' }, onDecision: decide(this.onCorrectionDecision) },
        { type: 'revenue.refund', agent: 'revenue', roles: [UserRole.ADMIN], primary: { kind: 'approve', label: 'Approve' }, onDecision: decide(this.onRefundDecision) },
      ],
      rules: [
        {
          key: 'revenue-never-hold-care',
          agent: 'revenue',
          label: 'Never hold care for money',
          description: 'Nothing in Revenue can block, delay or reorder treatment, tests, medicines or a bed',
          default: true,
          locked: true,
        },
        {
          key: 'revenue-deposit-reminders',
          agent: 'revenue',
          label: 'Remind the billing desk to collect deposits',
          description: 'Raise a task for the billing desk when an advance or top-up is due',
          default: true,
        },
      ],
      closeChecks: [{ agent: 'revenue', label: 'Bill settled', check: (caseId) => this.closeCheck(caseId) }],
      status: () => this.status(),
    };
  }

  /** 'fail' while the case's ER or admission bill is open, final with a balance, or has a refund not yet paid; 'pass' once settled; 'n/a' with no bill. */
  private async closeCheck(caseId: string): Promise<'pass' | 'fail' | 'n/a'> {
    if (!Types.ObjectId.isValid(caseId)) return 'n/a';
    const bills = await this.bills
      .find({ case: new Types.ObjectId(caseId), kind: { $in: ['er', 'admission'] } })
      .select('state totals.balance')
      .lean<{ _id: Types.ObjectId; state: string; totals?: { balance?: number } }[]>()
      .exec();
    if (!bills.length) return 'n/a';
    if (bills.some((b) => b.state === 'open' || (b.state === 'final' && (b.totals?.balance ?? 0) !== 0))) return 'fail';
    const unpaid = await this.refunds.countDocuments({ bill: { $in: bills.map((b) => b._id) }, state: { $in: ['requested', 'approved'] } }).exec();
    return unpaid ? 'fail' : 'pass';
  }

  /** Open bills, plus open deposit and top-up tasks, plus final bills that still have a balance. */
  private async status() {
    const [open, tasks, finals] = await Promise.all([
      this.bills.countDocuments({ state: 'open' }).exec(),
      this.alerts.countDocuments({ link: { $regex: OPEN_TASK_LINK }, status: { $ne: 'Completed' } }).exec(),
      this.bills.countDocuments({ state: 'final', 'totals.balance': { $ne: 0 } }).exec(),
    ]);
    return { open: open + tasks + finals, capacity: 0, onTimePct: null };
  }
}
