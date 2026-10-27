import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { BedAgentService } from './bed-agent.service';
import { BedOverviewService } from './bed-overview.service';

const RETRY_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Starts the Bed Agent's recovery at boot, then every minute as a backstop: it picks up
 * requests left searching (for example after a database outage) and retries waiting ones.
 * It also takes a bed snapshot at boot and at the top of every hour.
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
    // Wait for the next full hour, then repeat every hour.
    this.alignTimer = setTimeout(() => {
      this.snapshot();
      this.snapshotTimer = setInterval(() => this.snapshot(), HOUR_MS);
      this.snapshotTimer.unref();
    }, HOUR_MS - (Date.now() % HOUR_MS));
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
