import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallsService } from './calls.service';

/**
 * Runs the call agent's scheduler pass on an interval (CALL_SCHEDULER_INTERVAL_SECONDS,
 * 0 disables it). Each pass is safe to run on several API instances at once: calls are
 * claimed atomically before they are placed.
 */
@Injectable()
export class CallSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CallScheduler');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly calls: CallsService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    const seconds = this.config.get<number>('callAgent.schedulerIntervalSeconds') ?? 0;
    if (seconds <= 0 || this.calls.providerInfo.provider === 'none') return;
    this.timer = setInterval(() => {
      this.calls.runDue().catch((err) => this.logger.error(`Scheduler pass failed: ${err.message}`));
    }, seconds * 1000);
    this.timer.unref();
    this.logger.log(`Running every ${seconds}s with the ${this.calls.providerInfo.provider} provider`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
