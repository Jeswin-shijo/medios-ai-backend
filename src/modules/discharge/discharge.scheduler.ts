import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { clinicNow, isoDate } from '../../common/utils/clinic-time';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeOrdersService } from './discharge-orders.service';
import { DischargeOverviewService } from './discharge-overview.service';
import { DischargePlansService } from './discharge-plans.service';
import { DischargeRepairService } from './discharge-repair.service';

const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
/** After the hour turns, so a timer that fires a little early still lands in the new hour. */
const SNAPSHOT_MARGIN_MS = 1000;
/** The counter holding when the Discharge Agent first ran against this database (Revenue's R32 pattern). */
export const DISCHARGE_START = 'discharge-start';

/** Milliseconds from `now` to the next full (real) hour, plus the margin. */
export const untilNextHour = (now: number): number => HOUR_MS - (now % HOUR_MS) + SNAPSHOT_MARGIN_MS;

/** "2026-09-26T11": the clinic hour a snapshot belongs to. */
const hourKey = (d: Date) => `${isoDate(d)}T${String(d.getHours()).padStart(2, '0')}`;

/**
 * The Discharge agent's time-based work (R52: timers, guards, the start stamp and the step order only). Every minute,
 * in order: the catch-up (R17: every active stay gets a plan, however old) and orphan plans, the windows due, the
 * morning reminders, every open order's lines, then the repairs (re-sends, summaries, orders and plans, half-ended
 * stays), and the hourly snapshot when the clinic hour has turned. Every real hour (and at start-up) the snapshot too.
 * Each step logs its own failure and never stops the next; a pass is skipped while the previous one still runs. The
 * start stamp is stored at boot and read again by every pass (R32, as Revenue's reconcile does), so a reseed that resets
 * it while the API runs is honoured at once; it bounds the repairs: nothing from before it is re-sent, back-filled or
 * repaired.
 */
@Injectable()
export class DischargeScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('DischargeScheduler');
  private tickTimer?: NodeJS.Timeout;
  private alignTimer?: NodeJS.Timeout;
  private hourTimer?: NodeJS.Timeout;
  private running = false;
  private hourly = false;
  /** The clinic hour of the last snapshot this process took (or found already taken). */
  private snapped: string | null = null;

  /** The clinic clock (R7); a spec replaces it. */
  clock: () => Date = () => clinicNow();

  constructor(
    private readonly plans: DischargePlansService,
    private readonly orders: DischargeOrdersService,
    private readonly lines: DischargeLinesService,
    private readonly repair: DischargeRepairService,
    private readonly overview: DischargeOverviewService,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
  ) {}

  onApplicationBootstrap() {
    void this.startedAt().catch((e: Error) => this.logger.warn(`Discharge start time not stored yet (${e.message}); the next pass tries again`));
    void this.hour();
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    this.tickTimer.unref();
    this.alignTimer = setTimeout(() => {
      void this.hour();
      this.hourTimer = setInterval(() => void this.hour(), HOUR_MS);
      this.hourTimer.unref();
    }, untilNextHour(Date.now()));
    this.alignTimer.unref();
  }

  onModuleDestroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.alignTimer) clearTimeout(this.alignTimer);
    if (this.hourTimer) clearInterval(this.hourTimer);
  }

  /**
   * When the Discharge Agent first ran against this database: stored by the first read (`$setOnInsert`, one indexed
   * upsert), and read fresh every time, never kept for the process (13b review I2). A reseed deletes the counter and sets
   * it after its own records, while an API keeps running; the next pass must see the new stamp, or it would re-send and
   * repair the seeded records.
   */
  async startedAt(): Promise<Date> {
    const c = await this.counters.findOneAndUpdate({ key: DISCHARGE_START }, { $setOnInsert: { last: Date.now() } }, { upsert: true, new: true }).exec();
    return new Date(c.last);
  }

  /** The minute pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.clock();
      await this.step('catch-up', () => this.plans.catchUp());
      await this.step('orphan plans', () => this.plans.dropOrphans());
      await this.step('windows', () => this.orders.openDueWindows(now));
      await this.step('reminders', () => this.plans.remindDue(now));
      await this.step('lines', () => this.lines.refreshOpen());
      const start = await this.startedAt().catch((e: Error) => {
        this.logger.error(`Discharge start time not read (${e.message}): re-sends and repairs wait for the next pass`);
        return null;
      });
      if (start) {
        await this.step('re-sends', () => this.repair.resendMissing(start));
        await this.step('summaries', () => this.repair.repairSummaries(start));
        await this.step('orders and plans', () => this.repair.repairOrdersAndPlans(start));
        await this.step('endings', () => this.repair.repairEndings(now, start));
      }
      await this.hour();
    } finally {
      this.running = false;
    }
  }

  /**
   * The hourly snapshot, once per clinic hour: the minute pass asks too, so a missed or failed hour is taken within a
   * minute. Skipped while the previous one is still running.
   */
  async hour() {
    if (this.hourly) return;
    const key = hourKey(this.clock());
    if (key === this.snapped) return;
    this.hourly = true;
    try {
      await this.overview.snapshot();
      this.snapped = key;
    } catch (e) {
      this.logger.error(`Discharge snapshot failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.hourly = false;
    }
  }

  private async step(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (e) {
      this.logger.error(`Discharge minute pass: ${what} failed: ${(e as Error)?.message ?? e}`);
    }
  }
}
