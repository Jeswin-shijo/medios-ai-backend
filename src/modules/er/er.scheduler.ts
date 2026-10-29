import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { clinicNow } from '../../common/utils/clinic-time';
import { ErBaysService } from './er-bays.service';
import { ErOverviewService } from './er-overview.service';
import { ErVisitsService } from './er-visits.service';

const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
/** After the hour turns, so a timer that fires a little early still lands in the new hour. */
const SNAPSHOT_MARGIN_MS = 1000;

/** Milliseconds from `now` to the next full (real) hour, plus the margin. */
export const untilNextSnapshot = (now: number): number => HOUR_MS - (now % HOUR_MS) + SNAPSHOT_MARGIN_MS;

/**
 * The ER agent's time-based work: default bays and a first snapshot at start-up, then every minute
 * it expires old expected arrivals and resends lost arrival and departure messages, and it takes an
 * hourly snapshot. Every step logs its own failure and never stops the others.
 */
@Injectable()
export class ErScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ErScheduler');
  private tickTimer?: NodeJS.Timeout;
  private alignTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly visits: ErVisitsService,
    private readonly bays: ErBaysService,
    private readonly overview: ErOverviewService,
  ) {}

  onApplicationBootstrap() {
    void this.start();
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

  async start() {
    await this.step('Default bays', () => this.bays.ensureDefaults());
    await this.snapshot();
  }

  /** One pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // expectedAt is on the clinic clock, so "now" must be too.
      await this.step('Expire expected arrivals', () => this.visits.expireExpected(clinicNow()));
      await this.step('Resend lost announcements', () => this.visits.reannounce());
    } finally {
      this.running = false;
    }
  }

  snapshot() {
    return this.step('ER snapshot', () => this.overview.snapshot());
  }
}
