import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { escapeRegex } from '../../common/utils/escape-regex';
import { AgentRegistry } from '../coordinator/agent-registry';
import { AgentDefinition, AgentStatusReport, ClockDef, MessageTypeDef } from '../coordinator/coordinator-types';
import { MessagesService } from '../coordinator/messages.service';
import { CheckupCall, CheckupCallDocument } from './schemas/checkup-call.schema';
import { SupportTicket, SupportTicketDocument } from './schemas/support-ticket.schema';
import { TICKET_TYPE_LABEL, TicketType } from './support-catalogue';

type Fields = MessageTypeDef['payload'];
const type = (t: string, description: string, payload: Fields): MessageTypeDef => ({ type: t, agent: 'patient-support', description, payload });

/** Every field is required and non-null. No message carries a name, a phone number or free text. */
export const SUPPORT_MESSAGE_TYPES: MessageTypeDef[] = [
  type('support.update-sent', 'A family update was sent', { updateId: 'string', trigger: 'string', mode: 'string' }),
  type('support.update-skipped', 'A family update was skipped', { updateId: 'string', trigger: 'string', reason: 'string' }),
  type('support.ticket-opened', 'A support ticket (or a new round of one) was opened', {
    ticketId: 'string',
    number: 'string',
    ticketType: 'string',
    priority: 'string',
    ladder: 'string',
    round: 'number',
    dueAt: 'date'
  }),
  type('support.ticket-answered', "A ticket round's first response was given", { ticketId: 'string', number: 'string', round: 'number', handedOn: 'boolean' }),
  type('support.ticket-resolved', 'A support ticket was resolved', { ticketId: 'string', number: 'string', round: 'number' }),
  type('support.checkup-done', 'A check-up call ended', { checkupId: 'string', number: 'string', outcome: 'string' }),
  type('support.checkup-worrying', 'A check-up call needs a doctor', { checkupId: 'string', number: 'string', dueAt: 'date' }),
  type('support.checkup-reviewed', 'A doctor reviewed a check-up call', { checkupId: 'string', number: 'string' }),
  type('support.complaint', 'A complaint was recorded', { feedbackId: 'string', ticketId: 'string', number: 'string' })
];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const dueAtOf = (payload: Record<string, unknown>): Date | null => {
  const v = payload.dueAt;
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};
const byTicketRound = (_t: string, p: Record<string, unknown>): string | null => {
  const id = str(p.ticketId);
  return id && typeof p.round === 'number' ? `${id}:${p.round}` : null;
};
const byCheckup = (_t: string, p: Record<string, unknown>): string | null => str(p.checkupId);
/** "SP-0001 (Billing)": what an escalation is about. Never a name. */
const ticketDetail = (p: Record<string, unknown>): string | null => {
  const number = str(p.number);
  if (!number) return null;
  const label = TICKET_TYPE_LABEL[p.ticketType as TicketType];
  return Object.prototype.hasOwnProperty.call(TICKET_TYPE_LABEL, String(p.ticketType)) && label ? `${number} (${label})` : number;
};

const responseClock = (key: string, ladder: string, minutes: number): ClockDef => ({
  key,
  agent: 'patient-support',
  label: 'First response',
  startOn: 'support.ticket-opened',
  stopOn: ['support.ticket-answered', 'support.ticket-resolved'],
  // Only the start is filtered: each ticket round runs on its owner's ladder.
  match: (t, p) => t !== 'support.ticket-opened' || p.ladder === ladder,
  minutes,
  ladder,
  dueFrom: dueAtOf,
  refFrom: byTicketRound,
  resolveEscalationOnStop: true,
  resolvedBy: 'Ticket answered',
  alertLink: (ref) => (ref ? `support-ticket:${ref}` : null),
  detailFrom: ticketDetail
});

/** Exported for the demo seed. Start and stop messages must carry the same ticket and round (or check-up). */
export const SUPPORT_CLOCKS: ClockDef[] = [
  responseClock('support-response', 'patient-support', 240),
  responseClock('support-response-billing', 'support-billing', 240),
  responseClock('support-response-ward', 'support-ward', 240),
  responseClock('support-response-clinical', 'support-clinical', 30),
  {
    key: 'support-checkup-doctor',
    agent: 'patient-support',
    label: 'Doctor review',
    startOn: 'support.checkup-worrying',
    stopOn: ['support.checkup-reviewed'],
    minutes: 60,
    ladder: 'support-clinical',
    dueFrom: dueAtOf,
    refFrom: byCheckup,
    resolveEscalationOnStop: true,
    resolvedBy: 'Doctor reviewed',
    alertLink: (ref) => (ref ? `support-checkup:${ref}` : null),
    detailFrom: (p) => {
      const number = str(p.number);
      return number ? `${number} (needs doctor)` : null;
    }
  }
];

/** The other agents' messages that wake Patient Support. Each only wakes it; the handlers re-read the records. */
export const WAKE_TYPES = [
  'bed.assigned',
  'bed.transferred',
  'scheduling.procedure-booked',
  'scheduling.procedure-done',
  'revenue.estimate-ready',
  'revenue.bill-final',
  'discharge.completed',
  'scheduling.followup-booked'
] as const;

type WakeHandler = (messageId: string) => Promise<void>;

/** True when the summary holds the whole name as words of its own, in any letter case or spacing. */
function namesPatient(summary: string, name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const pattern = words.map((w) => escapeRegex(w)).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${pattern}(?![\\p{L}\\p{M}\\p{N}])`, 'iu').test(summary);
}

/** Tells the Coordinator what Patient Support sends, and the clocks and rules it brings. It has no close check. */
@Injectable()
export class SupportRegistration implements OnModuleInit {
  private readonly logger = new Logger(SupportRegistration.name);

  /** Handlers by message type, appended by the services that react (R2): several may share a type. */
  readonly wake = new Map<string, WakeHandler[]>();

  /** The real clock, for "today" in the status; a spec replaces it. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly messages: MessagesService,
    @InjectModel(SupportTicket.name) private readonly tickets: Model<SupportTicketDocument>,
    @InjectModel(CheckupCall.name) private readonly checkups: Model<CheckupCallDocument>
  ) {}

  onModuleInit(): void {
    this.registry.register(this.definition());
  }

  /** Adds a handler for a message type. Handlers for one type run in the order added. */
  onWake(messageType: string, handler: WakeHandler): void {
    const list = this.wake.get(messageType) ?? [];
    list.push(handler);
    this.wake.set(messageType, list);
  }

  /**
   * Sends a Patient Support message to the Coordinator, on the case when there is one. Never throws. When
   * `patientName` is given and the summary holds it, the message is refused (logged, false). True when it went (or
   * the same one went within the last minute); false, with a warning, when it was not sent.
   */
  async send(messageType: string, caseId: string | null, payload: Record<string, unknown>, summary: string, patientName?: string, dedupeKey?: string): Promise<boolean> {
    try {
      if (patientName && namesPatient(summary, patientName)) {
        this.logger.warn(`${messageType} not sent${caseId ? ` (case ${caseId})` : ''}: its summary named the patient`);
        return false;
      }
      await this.messages.send({ case: caseId, from: 'patient-support', to: ['coordinator'], type: messageType, priority: 'medium', summary, payload, ...(dedupeKey ? { dedupeKey } : {}) });
      return true;
    } catch (e) {
      this.logger.warn(`${messageType} not sent${caseId ? ` (case ${caseId})` : ''}: ${(e as Error).message}`);
      return false;
    }
  }

  private definition(): AgentDefinition {
    return {
      key: 'patient-support',
      messageTypes: SUPPORT_MESSAGE_TYPES,
      clocks: SUPPORT_CLOCKS,
      handles: WAKE_TYPES.map((t) => ({ type: t, handler: (id: string) => this.wakeOn(t, id) })),
      rules: [
        {
          key: 'support-consent',
          agent: 'patient-support',
          label: 'Never send without consent',
          description: 'Family updates go only to patients whose consent is recorded.',
          default: true,
          locked: true
        },
        {
          // No settingPath: the switch lives in settings.coordinator.rules.
          key: 'support-auto-updates',
          agent: 'patient-support',
          label: 'Send family updates automatically',
          description: 'When it is off, updates wait as Held for staff to send.',
          default: true
        }
      ],
      status: () => this.status()
    };
  }

  /** Runs each handler set for the type in turn. A throwing one is logged and the next still runs; nothing escapes. */
  private async wakeOn(messageType: string, messageId: string): Promise<void> {
    for (const handler of this.wake.get(messageType) ?? []) {
      try {
        await handler(messageId);
      } catch (e) {
        this.logger.error(`${messageType} (message ${messageId}) failed: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Open: tickets not resolved plus check-ups due or calling; no fixed capacity. On time: of the rounds answered
   * today (server-local day), the share answered by their `dueAt`. A ticket keeps only its current round's answer,
   * so an earlier, handed-on round is not counted. Null when none was answered today.
   */
  private async status(): Promise<AgentStatusReport> {
    const now = this.clock();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const [openTickets, openCheckups, answered] = await Promise.all([
      this.tickets.countDocuments({ state: { $ne: 'resolved' } }).exec(),
      this.checkups.countDocuments({ state: { $in: ['due', 'calling'] } }).exec(),
      this.tickets
        .find({ roundAnsweredAt: { $gte: dayStart, $lt: dayEnd } })
        .select('roundAnsweredAt dueAt')
        .lean<{ roundAnsweredAt: Date; dueAt: Date }[]>()
        .exec()
    ]);
    const onTime = answered.filter((t) => new Date(t.roundAnsweredAt).getTime() <= new Date(t.dueAt).getTime()).length;
    return { open: openTickets + openCheckups, capacity: null, onTimePct: answered.length ? Math.round((onTime / answered.length) * 100) : null };
  }
}
