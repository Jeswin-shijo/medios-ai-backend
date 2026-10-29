import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AgentRegistry } from './agent-registry';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';
import { Clock, ClockDocument, ClockState } from './schemas/clock.schema';
import type { MessageDocument } from './schemas/agent-message.schema';

const MINUTE_MS = 60_000;

export interface ClockView {
  id: string;
  def: string;
  case: string | null;
  startedBy: string;
  startedAt: string;
  dueAt: string;
  state: ClockState;
  stoppedAt: string | null;
  metMinutes: number | null;
  escalation: string | null;
}

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

function toView(c: any): ClockView {
  return {
    id: String(c._id),
    def: c.def,
    case: c.case ? String(c.case) : null,
    startedBy: String(c.startedBy),
    startedAt: iso(c.startedAt) as string,
    dueAt: iso(c.dueAt) as string,
    state: c.state,
    stoppedAt: iso(c.stoppedAt),
    metMinutes: c.metMinutes ?? null,
    escalation: c.escalation ? String(c.escalation) : null,
  };
}

/** Deadline clocks: a start message begins one, a stop message meets it, checkDue expires it. Real time. */
@Injectable()
export class ClocksService {
  private readonly logger = new Logger(ClocksService.name);
  private readonly unknownLogged = new Set<string>();

  constructor(
    @InjectModel(Clock.name) private readonly model: Model<ClockDocument>,
    private readonly registry: AgentRegistry,
    private readonly messages: MessagesService,
    private readonly escalations: EscalationsService,
  ) {
    this.messages.onStored((m) => this.onMessage(m));
  }

  private async onMessage(m: MessageDocument): Promise<void> {
    for (const def of this.registry.clocksStartingOn(m.type)) {
      try {
        await this.start(def.key, def.minutes, m);
      } catch (e) {
        this.logger.error(`Starting clock ${def.key} failed: ${(e as Error).message}`);
      }
    }
    for (const def of this.registry.clocksStoppingOn(m.type)) {
      try {
        await this.stop(def.key, m);
      } catch (e) {
        this.logger.error(`Stopping clock ${def.key} failed: ${(e as Error).message}`);
      }
    }
  }

  private async start(defKey: string, minutes: number, m: MessageDocument): Promise<void> {
    const startedAt = new Date();
    try {
      await this.model.create({
        def: defKey,
        case: m.case ?? null,
        startedBy: m._id,
        startedAt,
        dueAt: new Date(startedAt.getTime() + minutes * MINUTE_MS),
        state: 'running',
      });
    } catch (e) {
      // 11000: the partial unique index says one is already running, so a repeat changes nothing.
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }

  private async stop(defKey: string, m: MessageDocument): Promise<void> {
    const at = new Date();
    const key = { def: defKey, case: m.case ?? null };
    const metOf = (c: { startedAt: Date }) => Math.round((at.getTime() - new Date(c.startedAt).getTime()) / MINUTE_MS);
    const running = await this.model.findOne({ ...key, state: 'running' }).exec();
    if (running) {
      const met = await this.model
        .findOneAndUpdate({ _id: running._id, state: 'running' }, { $set: { state: 'met', stoppedAt: at, metMinutes: metOf(running) } })
        .exec();
      if (met) return;
    }
    // Already expired: record when it was finally met, but leave the state and its escalation alone.
    const expired = await this.model.findOne({ ...key, state: 'expired', stoppedAt: { $exists: false } }).sort({ startedAt: -1 }).exec();
    if (expired) {
      await this.model.updateOne({ _id: expired._id, stoppedAt: { $exists: false } }, { $set: { stoppedAt: at, metMinutes: metOf(expired) } }).exec();
    }
  }

  /** Expires running clocks past their time, sends clock.expired and raises each ladder. Returns how many expired. */
  async checkDue(now: Date): Promise<number> {
    const due = await this.model.find({ state: 'running', dueAt: { $lte: now } }).sort({ dueAt: 1 }).exec();
    let expired = 0;
    for (const c of due) {
      try {
        const def = this.registry.clock(c.def);
        if (!def) {
          if (!this.unknownLogged.has(c.def)) {
            this.unknownLogged.add(c.def);
            this.logger.warn(`Clock "${c.def}" is overdue but its definition is not registered; leaving it running`);
          }
          continue;
        }
        // The state in the filter stops two overlapping passes from expiring the same clock twice.
        const claimed = await this.model.findOneAndUpdate({ _id: c._id, state: 'running' }, { $set: { state: 'expired' } }, { new: true }).exec();
        if (!claimed) continue;
        expired += 1;
        const caseId = claimed.case ? String(claimed.case) : null;
        // The escalation matters more than the notice: a failed send must not stop it.
        await this.messages.send({
          case: caseId,
          from: 'coordinator',
          to: ['coordinator'],
          type: 'clock.expired',
          priority: 'high',
          summary: `${def.label} overdue`.slice(0, 140),
          payload: { clockKey: def.key },
          causedBy: String(claimed.startedBy),
          dedupeKey: `clock.expired:${claimed._id}`,
        }).catch((e) => this.logger.error(`Sending clock.expired for ${String(claimed._id)} failed: ${(e as Error).message}`));
        const esc = await this.escalations.raise({
          ladder: def.ladder,
          case: caseId,
          reason: `${def.label} overdue`,
          source: { kind: 'clock', id: String(claimed._id) },
        });
        await this.model.updateOne({ _id: claimed._id }, { $set: { escalation: esc._id } }).exec();
      } catch (e) {
        this.logger.error(`Expiring clock ${String(c._id)} failed: ${(e as Error).message}`);
      }
    }
    return expired;
  }

  async list(q: { state?: string; case?: string; limit?: number } = {}): Promise<ClockView[]> {
    const match: Record<string, unknown> = {};
    if (q.case && !Types.ObjectId.isValid(q.case)) throw new BadRequestException('"case" is not a valid id');
    if (q.case) match.case = new Types.ObjectId(q.case);
    if (q.state) match.state = q.state;
    const rows = await this.model
      .find(match)
      .sort({ startedAt: -1, _id: -1 })
      .limit(Math.min(Math.max(q.limit ?? 50, 1), 500))
      .lean()
      .exec();
    return rows.map(toView);
  }

  countRunning(): Promise<number> {
    return this.model.countDocuments({ state: 'running' }).exec();
  }
}
