import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import { clinicNow, displayDateTime } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { AgentCall, AgentCallDocument } from '../calls/schemas/agent-call.schema';
import { CasesService } from '../coordinator/cases.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { EscalationsService } from '../coordinator/escalations.service';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { SupportTicket, SupportTicketDocument } from './schemas/support-ticket.schema';
import {
  channelOf,
  OWNER_LABEL,
  OWNER_LADDER,
  OWNER_TITLE,
  OwnerKey,
  TICKET_SOURCES,
  TICKET_STATE_LABEL,
  TICKET_TYPE_LABEL,
  TICKET_TYPES,
  TicketSource,
  TicketState,
  TicketType
} from './support-catalogue';
import { SupportRegistration } from './support-coordinator.registration';
import { SupportFactsService } from './support-facts.service';
import { SUP_READ } from './support-roles';
import { SupportSettingsService } from './support-settings.service';
import { ticketDueAt } from './support-time';

const MIN = 60_000;
const COUNTER_KEY = 'support-ticket';
const DUPLICATE_KEY = 11000;
const RESOLVED = 'This ticket is already resolved.';
const FORBIDDEN = 'Only a doctor, a nurse, the front desk or an admin can do this.';

export interface OpenTicketInput {
  patientId?: string;
  callerName: string;
  callerPhone?: string;
  ticketType: string;
  question: string;
  urgent?: boolean;
  onTheSpot?: boolean;
  resolution?: string;
  source: string;
  channel?: string;
  providerCallId?: string;
  feedbackId?: string;
}

export interface TicketQuery {
  state?: string;
  /** `escalated` for the shown status Escalated, or a state key. */
  shown?: string;
  ticketType?: string;
  owner?: string;
  q?: string;
  /** Opened today (the server's day). */
  today?: boolean;
  limit?: number;
}

export interface SupportTicketView {
  id: string;
  number: string;
  patient: string | null;
  patientUhid: string;
  patientName: string;
  case: string | null;
  callerName: string;
  callerPhone: string;
  ticketType: string;
  typeLabel: string;
  owner: string;
  ownerLabel: string;
  ladder: string;
  priority: string;
  source: string;
  channel: string;
  question: string;
  state: string;
  /** Escalated when overdue and unanswered, else the state's label. */
  shown: string;
  round: number;
  dueAt: Date;
  escalatedAt: Date | null;
  roundAnsweredAt: Date | null;
  answeredAt: Date | null;
  firstResponseMinutes: number | null;
  openedAt: Date;
  openedByName: string;
  onTheSpot: boolean;
  resolvedAt: Date | null;
  resolvedByName: string;
  resolution: string;
  providerCallId: string;
  hasCall: boolean;
}
export type SupportTicketRow = SupportTicketView;
export interface SupportTicketDetail extends SupportTicketView {
  notes: { kind: string; text: string; by: string; byName: string; at: Date }[];
  transcript: { speaker: string; text: string }[];
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const typeLabel = (t: string) => TICKET_TYPE_LABEL[t as TicketType] ?? t;
const ownerLabel = (o: string) => OWNER_LABEL[o as OwnerKey] ?? o;
const alertLink = (id: unknown) => `support-ticket:${String(id)}:urgent`;
const text = (v: unknown, label: string, min: number, max: number): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw new BadRequestException(`${label} is required.`);
  if (s.length > max) throw new BadRequestException(`${label} can be at most ${max} characters.`);
  return s;
};

/**
 * One caller's question or complaint: numbered, owned by a front-desk person or a duty title, answered once per round and
 * resolved. Times on a ticket are real time (they drive clocks); only Timeline lines use the clinic clock.
 */
@Injectable()
export class SupportTicketsService {
  private readonly logger = new Logger(SupportTicketsService.name);

  /** The real clock; a spec replaces it. */
  now: () => Date = () => new Date();

  constructor(
    private readonly registration: SupportRegistration,
    private readonly settings: SupportSettingsService,
    private readonly facts: SupportFactsService,
    private readonly casesService: CasesService,
    private readonly escalations: EscalationsService,
    @InjectModel(SupportTicket.name) private readonly tickets: Model<SupportTicketDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    @InjectModel(AgentCall.name) private readonly agentCalls: Model<AgentCallDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>
  ) {}

  private check(actor: Actor): void {
    if (!actor || !SUP_READ.includes(actor.role)) throw new ForbiddenException(FORBIDDEN);
  }

  /** SP-0001 style numbers from the shared counter collection (Discharge's `nextNumber`). */
  private async nextNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: COUNTER_KEY }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `SP-${String(c.last).padStart(4, '0')}`;
  }

  private async load(id: string): Promise<SupportTicketDocument> {
    if (!isValidObjectId(id)) throw new NotFoundException('Ticket not found.');
    const t = await this.tickets.findById(id).exec();
    if (!t) throw new NotFoundException('Ticket not found.');
    if (t.state === 'resolved') throw new ConflictException(RESOLVED);
    return t;
  }

  /** The list row of a ticket document; the overview reuses it so its rows match the list. */
  view(t: any): SupportTicketView {
    const escalated = !!t.escalatedAt && !t.roundAnsweredAt && t.state !== 'resolved';
    return {
      id: String(t._id),
      number: t.number,
      patient: t.patient ? String(t.patient) : null,
      patientUhid: t.patientUhid ?? '',
      patientName: t.patientName ?? '',
      case: t.case ? String(t.case) : null,
      callerName: t.callerName ?? '',
      callerPhone: t.callerPhone ?? '',
      ticketType: t.ticketType,
      typeLabel: typeLabel(t.ticketType),
      owner: t.owner,
      ownerLabel: ownerLabel(t.owner),
      ladder: t.ladder,
      priority: t.priority,
      source: t.source,
      channel: t.channel,
      question: t.question,
      state: t.state,
      shown: escalated ? 'Escalated' : (TICKET_STATE_LABEL[t.state as TicketState] ?? t.state),
      round: t.round,
      dueAt: t.dueAt,
      escalatedAt: t.escalatedAt ?? null,
      roundAnsweredAt: t.roundAnsweredAt ?? null,
      answeredAt: t.answeredAt ?? null,
      firstResponseMinutes: t.firstResponseMinutes ?? null,
      openedAt: t.openedAt,
      openedByName: t.openedByName ?? '',
      onTheSpot: !!t.onTheSpot,
      resolvedAt: t.resolvedAt ?? null,
      resolvedByName: t.resolvedByName ?? '',
      resolution: t.resolution ?? '',
      providerCallId: t.providerCallId ?? '',
      hasCall: !!t.agentCall
    };
  }

  private caseOf(t: { case?: unknown }): string | null {
    return t.case ? String(t.case) : null;
  }

  private nameOf(t: { patientName?: string; callerName?: string }): string {
    return t.patientName || t.callerName || '';
  }

  /** Opens a ticket, or returns the one already opened for the same provider call id. */
  async open(actor: Actor, input: OpenTicketInput): Promise<SupportTicketView> {
    this.check(actor);
    const callerName = text(input.callerName, 'The caller name', 1, 80);
    const callerPhone = typeof input.callerPhone === 'string' ? input.callerPhone.trim() : '';
    if (callerPhone.length > 20) throw new BadRequestException('The phone number can be at most 20 characters.');
    const question = text(input.question, 'The question', 1, 1000);
    if (!TICKET_TYPES.includes(input.ticketType as TicketType)) throw new BadRequestException('Choose a ticket type.');
    if (!TICKET_SOURCES.includes(input.source as TicketSource)) throw new BadRequestException('Unknown ticket source.');
    const source = input.source as TicketSource;
    if (input.channel !== undefined && source !== 'desk') throw new BadRequestException('Only a desk ticket has a channel.');
    if (input.channel !== undefined && input.channel !== 'desk' && input.channel !== 'phone')
      throw new BadRequestException('The channel is At the desk or By phone.');
    const channel = source === 'desk' ? (input.channel ?? 'desk') : channelOf(source);
    const onTheSpot = input.onTheSpot === true;
    const resolution = onTheSpot ? text(input.resolution, 'The answer given', 1, 1000) : '';

    if (input.providerCallId) {
      const existing = await this.tickets.findOne({ providerCallId: input.providerCallId }).lean().exec();
      if (existing) return this.view(existing);
    }

    let patient: PatientDocument | null = null;
    if (input.patientId) {
      patient = isValidObjectId(input.patientId) ? await this.patients.findById(input.patientId).exec() : null;
      if (!patient) throw new NotFoundException('Patient not found.');
    }
    let caseId: Types.ObjectId | undefined;
    if (patient) {
      const c = await this.casesService.forPatient(String(patient._id));
      if (c && c.state === 'open') caseId = c._id as Types.ObjectId;
    }

    const cfg = await this.settings.get();
    const ticketType = input.ticketType as TicketType;
    const owner = cfg.ownerByType[ticketType];
    const priority = input.urgent === true || input.urgent === ('true' as unknown) ? 'urgent' : 'normal';
    const now = this.now();
    let ticket: SupportTicketDocument;
    try {
      ticket = await this.tickets.create({
        number: await this.nextNumber(),
        patient: patient?._id,
        patientUhid: patient?.uhid,
        patientName: patient?.name,
        case: caseId,
        callerName,
        callerPhone,
        ticketType,
        owner,
        ladder: OWNER_LADDER[owner],
        priority,
        source,
        channel,
        question,
        state: onTheSpot ? 'resolved' : 'open',
        round: 1,
        dueAt: ticketDueAt(now, { priority, ticketType }, cfg),
        openedById: actor.id,
        openedByName: actor.name,
        openedAt: now,
        onTheSpot,
        ...(onTheSpot ? { resolvedAt: now, resolvedByName: actor.name, resolution } : {}),
        providerCallId: input.providerCallId || undefined,
        feedback: input.feedbackId && isValidObjectId(input.feedbackId) ? new Types.ObjectId(input.feedbackId) : undefined
      });
    } catch (e) {
      if ((e as { code?: number }).code === DUPLICATE_KEY && input.providerCallId) {
        const existing = await this.tickets.findOne({ providerCallId: input.providerCallId }).lean().exec();
        if (existing) return this.view(existing);
      }
      throw e;
    }

    const label = typeLabel(ticketType);
    if (ticket.patientUhid) await this.facts.timeline({ patientUhid: ticket.patientUhid }, `Ticket ${ticket.number} opened: ${label}`, cut(question, 120));
    if (onTheSpot) {
      await this.announce(ticket, 'resolved');
      if (ticket.patientUhid) await this.facts.timeline({ patientUhid: ticket.patientUhid }, `Ticket ${ticket.number} resolved`, cut(resolution, 120));
    } else {
      await this.announce(ticket, 'opened');
      if (priority === 'urgent') await this.writeUrgentAlert(ticket, 'Pending');
    }
    return this.view(ticket.toObject());
  }

  /** Sends a ticket message; records `<kind>:<round>` on the ticket only when it went, so `reannounce` can repair a lost one. */
  private async announce(t: SupportTicketDocument, kind: 'opened' | 'answered' | 'resolved', handedOn = false, repeat = false): Promise<boolean> {
    const id = String(t._id);
    // A deliberate repeat must not be dropped as a same-minute duplicate of the stop that went too early.
    const dedupeKey = repeat ? `support-repeat:${id}:${kind}:${t.round}:${Date.now()}` : undefined;
    let ok: boolean;
    if (kind === 'opened') {
      const summary =
        t.round > 1
          ? `${t.number} handed on to ${ownerLabel(t.owner)}`
          : `${t.number} opened: ${typeLabel(t.ticketType)}${t.priority === 'urgent' ? ' (Urgent)' : ''}`;
      ok = await this.registration.send(
        'support.ticket-opened',
        this.caseOf(t),
        { ticketId: id, number: t.number, ticketType: t.ticketType, priority: t.priority, ladder: t.ladder, round: t.round, dueAt: t.dueAt },
        summary,
        this.nameOf(t),
        dedupeKey
      );
    } else if (kind === 'answered') {
      ok = await this.registration.send(
        'support.ticket-answered',
        this.caseOf(t),
        { ticketId: id, number: t.number, round: t.round, handedOn },
        handedOn ? `${t.number} handed on` : `${t.number} answered`,
        this.nameOf(t),
        dedupeKey
      );
    } else {
      ok = await this.registration.send(
        'support.ticket-resolved',
        this.caseOf(t),
        { ticketId: id, number: t.number, round: t.round },
        `${t.number} resolved`,
        this.nameOf(t),
        dedupeKey
      );
    }
    if (!ok) {
      this.logger.warn(`${t.number}: the ${kind} message for round ${t.round} was not sent; it is re-sent on the next pass`);
      return false;
    }
    try {
      await this.tickets.updateOne({ _id: t._id }, { $addToSet: { announced: `${kind}:${t.round}` } }).exec();
    } catch (e) {
      this.logger.warn(`${t.number}: announcement not recorded: ${(e as Error).message}`);
    }
    if (kind === 'opened') await this.stopIfEarly(t);
    return true;
  }

  /** A stop that went before its round's start leaves a clock running: once the start is out, repeat the stop if the round already ended. */
  private async stopIfEarly(t: SupportTicketDocument): Promise<void> {
    const now = await this.tickets.findById(t._id).exec();
    if (!now || now.round !== t.round) return;
    if (now.state === 'resolved') await this.announceStop(now, 'resolved');
    else if (now.roundAnsweredAt) await this.announceStop(now, 'answered');
  }

  private async announceStop(t: SupportTicketDocument, kind: 'answered' | 'resolved'): Promise<boolean> {
    return this.announce(t, kind, false, true);
  }

  /** Re-sends missing announcements for open and recently resolved tickets (current round only). Returns how many went. */
  async reannounce(): Promise<number> {
    const since = new Date(this.now().getTime() - 24 * 60 * MIN);
    const rows = await this.tickets
      .find({ $or: [{ state: { $ne: 'resolved' } }, { resolvedAt: { $gte: since } }] })
      .sort({ openedAt: 1 })
      .limit(500)
      .exec();
    let sentCount = 0;
    for (const t of rows) {
      const has = (k: string) => (t.announced ?? []).includes(`${k}:${t.round}`);
      try {
        if (!t.onTheSpot && !has('opened') && (await this.announce(t, 'opened'))) sentCount++;
        if (t.state === 'resolved') {
          if (!has('resolved') && (await this.announce(t, 'resolved'))) sentCount++;
        } else if (t.roundAnsweredAt && !has('answered') && (await this.announce(t, 'answered'))) sentCount++;
      } catch (e) {
        this.logger.warn(`${t.number}: re-announce failed: ${(e as Error).message}`);
      }
    }
    return sentCount;
  }

  /** The urgent alert names the owner title and its holders, never the patient in its title. Never throws. */
  private async writeUrgentAlert(t: SupportTicketDocument, status: 'Pending' | 'Completed'): Promise<void> {
    try {
      const owner = t.owner as OwnerKey;
      const titleKey = OWNER_TITLE[owner];
      let who = 'Front desk';
      if (titleKey) {
        const names = (await this.escalations.holders(titleKey)).names;
        who = names.length ? names.join(', ') : 'Admins';
      }
      const fields = {
        title: `Urgent ticket ${t.number} for ${ownerLabel(t.owner)}: ${typeLabel(t.ticketType)}`,
        subtitle: `${who} · ${t.channel === 'phone' ? 'Phone' : 'Desk'}`,
        patientName: t.patientName ?? '',
        uhid: t.patientUhid ?? '',
        type: 'Patient Communication',
        category: 'Critical',
        priority: 'High',
        status,
        dueDateTime: displayDateTime(clinicNow())
      };
      try {
        await this.alerts.updateOne({ link: alertLink(t._id) }, { $set: fields }, { upsert: true }).exec();
      } catch (e) {
        if ((e as { code?: number }).code !== DUPLICATE_KEY) throw e;
        await this.alerts.updateOne({ link: alertLink(t._id) }, { $set: fields }).exec();
      }
    } catch (e) {
      this.logger.warn(`Urgent alert for ${t.number} not written: ${(e as Error).message}`);
    }
  }

  private async completeUrgentAlert(id: unknown): Promise<void> {
    try {
      await this.alerts.updateOne({ link: alertLink(id), status: { $ne: 'Completed' } }, { $set: { status: 'Completed' } }).exec();
    } catch (e) {
      this.logger.warn(`Urgent alert not closed: ${(e as Error).message}`);
    }
  }

  /**
   * The ticket's first response for its current round, once. Returns true when this call made it. `announce` false is for a
   * resolve, which sends its own message.
   */
  private async answerRound(id: Types.ObjectId, round: number, now: Date, announce: boolean): Promise<boolean> {
    const claimed = await this.tickets
      .findOneAndUpdate(
        { _id: id, round, state: { $ne: 'resolved' }, roundAnsweredAt: null },
        { $set: { roundAnsweredAt: now }, $unset: { escalatedAt: 1 } },
        { new: true }
      )
      .exec();
    if (!claimed) return false;
    let t = claimed;
    if (!t.answeredAt && !t.onTheSpot) {
      const minutes = Math.max(0, Math.floor((now.getTime() - new Date(t.openedAt).getTime()) / 60000));
      t =
        (await this.tickets
          .findOneAndUpdate({ _id: id, answeredAt: null }, { $set: { answeredAt: now, firstResponseMinutes: minutes } }, { new: true })
          .exec()) ?? t;
    }
    await this.completeUrgentAlert(t._id);
    if (announce) await this.announce(t, 'answered');
    return true;
  }

  private async push(id: Types.ObjectId, actor: Actor, kind: string, body: string, now: Date, set: Record<string, unknown> = {}): Promise<void> {
    const r = await this.tickets
      .updateOne(
        { _id: id, state: { $ne: 'resolved' } },
        { $push: { notes: { kind, text: body, by: actor.id, byName: actor.name, at: now } }, ...(Object.keys(set).length ? { $set: set } : {}) }
      )
      .exec();
    if (r.matchedCount === 0) throw new ConflictException(RESOLVED);
  }

  /** A note. It is the round's first response when the round is unanswered. */
  async note(actor: Actor, id: string, body: string): Promise<SupportTicketDetail> {
    this.check(actor);
    const clean = text(body, 'The note', 1, 1000);
    const t = await this.load(id);
    const now = this.now();
    await this.push(t._id as Types.ObjectId, actor, 'note', clean, now);
    await this.answerRound(t._id as Types.ObjectId, t.round, now, true);
    return this.detail(id);
  }

  /** In progress or Waiting on caller: a first response. */
  async setState(actor: Actor, id: string, state: string): Promise<SupportTicketDetail> {
    this.check(actor);
    if (state !== 'in-progress' && state !== 'waiting') throw new BadRequestException('Choose In progress or Waiting on caller.');
    const t = await this.load(id);
    const now = this.now();
    await this.push(t._id as Types.ObjectId, actor, 'state', `Marked ${TICKET_STATE_LABEL[state as TicketState]}`, now, { state });
    await this.answerRound(t._id as Types.ObjectId, t.round, now, true);
    return this.detail(id);
  }

  /** Hands the ticket to the owner of another type: a new round with its own clock (A2). Not a first response. */
  async handOn(actor: Actor, id: string, ticketType: TicketType, note?: string): Promise<SupportTicketDetail> {
    this.check(actor);
    if (!TICKET_TYPES.includes(ticketType)) throw new BadRequestException('Choose a ticket type.');
    const extra = note === undefined || note === null || note === '' ? '' : text(note, 'The note', 1, 500);
    const t = await this.load(id);
    if (t.ticketType === ticketType) throw new BadRequestException('The ticket already has that type.');
    const cfg = await this.settings.get();
    const now = this.now();
    const owner = cfg.ownerByType[ticketType];
    const updated = await this.tickets
      .findOneAndUpdate(
        { _id: t._id, state: { $ne: 'resolved' }, round: t.round },
        {
          $set: {
            ticketType,
            owner,
            ladder: OWNER_LADDER[owner],
            round: t.round + 1,
            state: 'open',
            dueAt: ticketDueAt(now, { priority: t.priority, ticketType }, cfg)
          },
          $unset: { roundAnsweredAt: 1, escalatedAt: 1 },
          $push: {
            notes: {
              kind: 'hand-on',
              text: `Handed on to ${ownerLabel(owner)} (${typeLabel(ticketType)})${extra ? `: ${extra}` : ''}`,
              by: actor.id,
              byName: actor.name,
              at: now
            }
          }
        },
        { new: false }
      )
      .exec();
    if (!updated) throw new ConflictException('This ticket changed meanwhile. Reload and try again.');
    // The old round closes (its clock and any escalation); then the new owner's round starts.
    if (!updated.roundAnsweredAt) await this.announce(updated, 'answered', true);
    const next = (await this.tickets.findById(t._id).exec())!;
    await this.announce(next, 'opened');
    if (next.priority === 'urgent') await this.writeUrgentAlert(next, 'Pending');
    return this.detail(id);
  }

  async resolve(actor: Actor, id: string, resolution: string): Promise<SupportTicketDetail> {
    this.check(actor);
    const clean = text(resolution, 'The resolution', 1, 1000);
    const t = await this.load(id);
    const now = this.now();
    const claimed = await this.tickets
      .findOneAndUpdate(
        { _id: t._id, state: { $ne: 'resolved' } },
        {
          $set: { state: 'resolved', resolvedAt: now, resolvedByName: actor.name, resolution: clean },
          $push: { notes: { kind: 'resolve', text: clean, by: actor.id, byName: actor.name, at: now } }
        },
        { new: true }
      )
      .exec();
    if (!claimed) throw new ConflictException(RESOLVED);
    // Resolving is a first response too (answered fields), but it sends only `ticket-resolved`.
    if (!claimed.roundAnsweredAt) {
      const set: Record<string, unknown> = { roundAnsweredAt: now };
      if (!claimed.answeredAt) {
        set.answeredAt = now;
        set.firstResponseMinutes = Math.max(0, Math.floor((now.getTime() - new Date(claimed.openedAt).getTime()) / 60000));
      }
      await this.tickets.updateOne({ _id: claimed._id }, { $set: set, $unset: { escalatedAt: 1 } }).exec();
    } else if (claimed.escalatedAt) {
      await this.tickets.updateOne({ _id: claimed._id }, { $unset: { escalatedAt: 1 } }).exec();
    }
    await this.completeUrgentAlert(claimed._id);
    await this.announce(claimed, 'resolved');
    if (claimed.patientUhid) await this.facts.timeline({ patientUhid: claimed.patientUhid }, `Ticket ${claimed.number} resolved`, cut(clean, 120));
    return this.detail(id);
  }

  /** Flags unresolved tickets whose round is unanswered and past due, once. Returns how many were flagged. */
  async markEscalated(now: Date = this.now()): Promise<number> {
    const r = await this.tickets
      .updateMany({ state: { $ne: 'resolved' }, roundAnsweredAt: null, escalatedAt: null, dueAt: { $lt: now } }, { $set: { escalatedAt: now } })
      .exec();
    return r.modifiedCount;
  }

  /** Attaches the call's record, so the transcript shows on the ticket. */
  async attachCall(providerCallId: string, agentCallId: string): Promise<void> {
    if (!providerCallId || !isValidObjectId(agentCallId)) return;
    await this.tickets.updateOne({ providerCallId }, { $set: { agentCall: new Types.ObjectId(agentCallId) } }).exec();
  }

  async list(q: TicketQuery = {}): Promise<SupportTicketRow[]> {
    const f: Record<string, unknown> = {};
    if (q.state) f.state = q.state;
    if (q.shown === 'escalated') Object.assign(f, { escalatedAt: { $ne: null }, roundAnsweredAt: null, state: { $ne: 'resolved' } });
    else if (q.shown) f.state = q.shown;
    if (q.ticketType) f.ticketType = q.ticketType;
    if (q.owner) f.owner = q.owner;
    if (q.today) {
      const start = this.now();
      start.setHours(0, 0, 0, 0);
      f.openedAt = { $gte: start };
    }
    const term = typeof q.q === 'string' ? q.q.trim() : '';
    if (term) {
      const re = new RegExp(escapeRe(term.slice(0, 80)), 'i');
      f.$or = [{ number: re }, { callerName: re }, { patientName: re }, { patientUhid: re }, { question: re }];
    }
    const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 200, 1), 500);
    const rows = await this.tickets.find(f).sort({ openedAt: -1, _id: -1 }).limit(limit).lean().exec();
    return rows.map((r) => this.view(r));
  }

  async detail(id: string): Promise<SupportTicketDetail> {
    if (!isValidObjectId(id)) throw new NotFoundException('Ticket not found.');
    const t = await this.tickets.findById(id).lean().exec();
    if (!t) throw new NotFoundException('Ticket not found.');
    let transcript: { speaker: string; text: string }[] = [];
    if (t.agentCall) {
      const call = await this.agentCalls.findById(t.agentCall).select('transcript').lean().exec();
      transcript = (call?.transcript ?? []).map((l) => ({ speaker: l.speaker, text: l.text }));
    }
    return {
      ...this.view(t),
      notes: (t.notes ?? []).map((n) => ({ kind: n.kind, text: n.text, by: n.by, byName: n.byName, at: n.at })),
      transcript
    };
  }
}
