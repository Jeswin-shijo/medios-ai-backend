import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { RevenueOverviewService } from './revenue-overview.service';
import { RevenueReconcileService } from './revenue-reconcile.service';

const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
/** After the hour turns, so a timer that fires a little early still lands in the new hour. */
const SNAPSHOT_MARGIN_MS = 1000;

/** Milliseconds from `now` to the next full (real) hour, plus the margin. */
export const untilNextHour = (now: number): number => HOUR_MS - (now % HOUR_MS) + SNAPSHOT_MARGIN_MS;

/**
 * The Revenue agent's time-based work: every minute the reconcile pass (which also runs bed days, the OPD catch-up and the
 * settling of reception kiosk bills, R30), and every real hour a snapshot (one at start-up too). Each pass logs its own
 * failure and is skipped while the previous one is still running, so one failed pass never stops the timer.
 */
@Injectable()
export class RevenueScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RevenueScheduler');
  private tickTimer?: NodeJS.Timeout;
  private alignTimer?: NodeJS.Timeout;
  private hourTimer?: NodeJS.Timeout;
  private running = false;
  private hourly = false;

  constructor(
    private readonly reconcileService: RevenueReconcileService,
    private readonly overview: RevenueOverviewService,
  ) {}

  onApplicationBootstrap() {
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

  /** The minute pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.reconcileService.reconcile();
    } catch (e) {
      this.logger.error(`Reconcile revenue failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  /** The hourly snapshot; skipped while the previous one is still running. */
  async hour() {
    if (this.hourly) return;
    this.hourly = true;
    try {
      await this.overview.snapshot();
    } catch (e) {
      this.logger.error(`Revenue snapshot failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.hourly = false;
    }
  }
}
