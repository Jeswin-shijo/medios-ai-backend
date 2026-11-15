import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { SupportCheckupsService } from './support-checkups.service';
import { SupportTextsService } from './support-texts.service';
import { SupportTicketsService } from './support-tickets.service';
import { SupportUpdatesService } from './support-updates.service';

const TICK_MS = 60_000;
/** The counter holding when Patient Support first ran against this database (Discharge's pattern). */
export const SUPPORT_START = 'support-start';

/**
 * Patient Support's time-based work. Every minute, in order: replay the messages since the start stamp, remind and send
 * the updates that are due, flag tickets nobody answered, announce what a crash left unannounced, make check-ups due,
 * match finished calls, dial, and repair check-up effects. Each step logs its own failure and never stops the next, and a
 * pass is skipped while the previous one is still running. The start stamp is stored at boot and read again by every pass,
 * so a reseed that resets it while the API runs is honoured at once; the catch-up never looks before it.
 */
@Injectable()
export class SupportScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('SupportScheduler');
  private tickTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly updates: SupportUpdatesService,
    private readonly tickets: SupportTicketsService,
    private readonly checkups: SupportCheckupsService,
    private readonly texts: SupportTextsService,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>
  ) {}

  onApplicationBootstrap() {
    // The default templates and hospital facts are written once, never over an admin's edit.
    void this.texts.ensureDefaults().catch((e: Error) => this.logger.error(`Default texts not stored: ${e.message}`));
    void this.startedAt().catch((e: Error) => this.logger.warn(`Patient Support start time not stored yet (${e.message}); the next pass tries again`));
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    this.tickTimer.unref();
  }

  onModuleDestroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  /** When Patient Support first ran against this database: stored by the first read (`$setOnInsert`), read fresh every time. */
  async startedAt(): Promise<Date> {
    const c = await this.counters.findOneAndUpdate({ key: SUPPORT_START }, { $setOnInsert: { last: Date.now() } }, { upsert: true, new: true }).exec();
    return new Date(c.last);
  }

  /** The minute pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const start = await this.startedAt().catch((e: Error) => {
        this.logger.error(`Patient Support start time not read (${e.message}): the catch-up waits for the next pass`);
        return null;
      });
      if (start) await this.step('catch-up', () => this.updates.catchUp(start));
      await this.step('reminders', () => this.updates.remindDue());
      await this.step('sends', () => this.updates.sendDue());
      await this.step('escalations', () => this.tickets.markEscalated());
      await this.step('announcements', () => this.tickets.reannounce());
      await this.step('check-ups due', () => this.checkups.makeDue());
      await this.step('call results', () => this.checkups.syncCalls());
      await this.step('check-up calls', () => this.checkups.dialDue());
      await this.step('check-up repairs', () => this.checkups.repairEffects());
    } finally {
      this.running = false;
    }
  }

  private async step(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e) {
      this.logger.error(`Patient Support minute pass: ${what} failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
