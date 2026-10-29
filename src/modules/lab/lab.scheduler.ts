import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { LabOrdersService } from './lab-orders.service';
import { LabOverviewService } from './lab-overview.service';
import { LabResultsService } from './lab-results.service';

const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
/** After the hour turns, so a timer that fires a little early still lands in the new hour. */
const SNAPSHOT_MARGIN_MS = 1000;

/** Milliseconds from `now` to the next full (real) hour, plus the margin. */
export const untilNextSnapshot = (now: number): number => HOUR_MS - (now % HOUR_MS) + SNAPSHOT_MARGIN_MS;

/**
 * The Lab agent's time-based work: a snapshot at start-up, then every minute the reconcile pass
 * (lost messages, missing reports, critical results) and an hourly snapshot. Each step logs its own failure and never
 * stops the others.
 */
@Injectable()
export class LabScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('LabScheduler');
  private tickTimer?: NodeJS.Timeout;
  private alignTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly orders: LabOrdersService,
    private readonly overview: LabOverviewService,
    private readonly results: LabResultsService,
  ) {}

  onApplicationBootstrap() {
    void this.snapshot();
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    this.tickTimer.unref();

    this.alignTimer = setTimeout(() => {
      void this.snapshot();
      this.snapshotTimer = setInterval(() => void this.snapshot(), HOUR_MS);
      this.snapshotTimer.unref();
    }, untilNextSnapshot(Date.now()));
    this.alignTimer.unref();
  }

  onModuleDestroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.alignTimer) clearTimeout(this.alignTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
  }

  private async step(name: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.logger.error(`${name} failed: ${(e as Error)?.message ?? e}`);
    }
  }

  /** One pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.step('Reconcile lab requests', () => this.orders.reconcile());
      await this.step('Reconcile critical lab results', () => this.results.reconcileCriticals());
    } finally {
      this.running = false;
    }
  }

  snapshot() {
    return this.step('Lab snapshot', () => this.overview.snapshot());
  }
}
