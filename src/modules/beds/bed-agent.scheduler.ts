import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { BedAgentService } from './bed-agent.service';
import { BedOverviewService } from './bed-overview.service';

const RETRY_MS = 60_000;
const HOUR_MS = 3_600_000;
/** After the hour turns, so a timer that fires a little early still lands in the new hour. */
const SNAPSHOT_MARGIN_MS = 1000;

/** Milliseconds from `now` to the next full (real) hour, plus the margin. */
export const untilNextSnapshot = (now: number): number => HOUR_MS - (now % HOUR_MS) + SNAPSHOT_MARGIN_MS;

/**
 * Starts the Bed Agent's recovery at boot, then every minute as a backstop: it picks up
 * requests left searching (for example after a database outage), retries waiting ones and
 * closes requests needing attention that no longer make sense. It also takes a bed snapshot
 * at boot and just after the top of every hour.
 */
@Injectable()
export class BedAgentScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('BedAgentScheduler');
  private retryTimer?: NodeJS.Timeout;
  private alignTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;

  constructor(
    private readonly agent: BedAgentService,
    private readonly overview: BedOverviewService,
  ) {}

  onApplicationBootstrap() {
    this.recover();
    this.retryTimer = setInterval(() => this.recover(), RETRY_MS);
    this.retryTimer.unref();

    this.snapshot();
    // Wait for the next full hour (and a second), then repeat every hour.
    this.alignTimer = setTimeout(() => {
      this.snapshot();
      this.snapshotTimer = setInterval(() => this.snapshot(), HOUR_MS);
      this.snapshotTimer.unref();
    }, untilNextSnapshot(Date.now()));
    this.alignTimer.unref();
  }

  onModuleDestroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    if (this.alignTimer) clearTimeout(this.alignTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
  }

  private recover() {
    this.agent.recover().catch((err) => this.logger.error(`Bed Agent recovery failed: ${err?.message ?? err}`));
  }

  private snapshot() {
    this.overview.snapshot().catch((err) => this.logger.error(`Bed snapshot failed: ${err?.message ?? err}`));
  }
}
