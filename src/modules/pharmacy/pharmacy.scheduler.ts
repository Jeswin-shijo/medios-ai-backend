import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PharmacyOverviewService } from './pharmacy-overview.service';
import { PharmacyReconcileService } from './pharmacy-reconcile.service';
import { PharmacyStockService } from './pharmacy-stock.service';

const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
/** After the hour turns, so a timer that fires a little early still lands in the new hour. */
const SNAPSHOT_MARGIN_MS = 1000;

/** Milliseconds from `now` to the next full (real) hour, plus the margin. */
export const untilNextHour = (now: number): number => HOUR_MS - (now % HOUR_MS) + SNAPSHOT_MARGIN_MS;

/**
 * The Pharmacy agent's time-based work: a snapshot and a low-stock sweep at start-up, then every minute the reconcile
 * pass and every real hour a snapshot and a low-stock sweep. Each step logs its own failure and never stops the others;
 * a pass is skipped while the previous one is still running.
 */
@Injectable()
export class PharmacyScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('PharmacyScheduler');
  private tickTimer?: NodeJS.Timeout;
  private alignTimer?: NodeJS.Timeout;
  private hourTimer?: NodeJS.Timeout;
  private running = false;
  private hourly = false;

  constructor(
    private readonly overview: PharmacyOverviewService,
    private readonly stock: PharmacyStockService,
    private readonly reconcile: PharmacyReconcileService,
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

  private async step(name: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.logger.error(`${name} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /** One minute pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.step('Reconcile pharmacy', () => this.reconcile.reconcile());
    } finally {
      this.running = false;
    }
  }

  /** The hourly pass: the snapshot and the low-stock sweep; skipped while the previous one is still running. */
  async hour() {
    if (this.hourly) return;
    this.hourly = true;
    try {
      await this.step('Pharmacy snapshot', () => this.overview.snapshot());
      await this.step('Low-stock sweep', () => this.stock.sweepLowStock());
    } finally {
      this.hourly = false;
    }
  }
}
