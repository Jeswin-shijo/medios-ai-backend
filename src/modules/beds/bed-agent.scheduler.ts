import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { BedAgentService } from './bed-agent.service';

const RETRY_MS = 60_000;

/**
 * Starts the Bed Agent's recovery at boot, then every minute as a backstop: it picks up
 * requests left searching (for example after a database outage) and retries waiting ones.
 */
@Injectable()
export class BedAgentScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('BedAgentScheduler');
  private retryTimer?: NodeJS.Timeout;

  constructor(private readonly agent: BedAgentService) {}

  onApplicationBootstrap() {
    this.recover();
    this.retryTimer = setInterval(() => this.recover(), RETRY_MS);
    this.retryTimer.unref();
  }

  onModuleDestroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  private recover() {
    this.agent.recover().catch((err) => this.logger.error(`Bed Agent recovery failed: ${err?.message ?? err}`));
  }
}
