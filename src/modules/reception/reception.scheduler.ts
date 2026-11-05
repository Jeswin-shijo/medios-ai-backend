import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { OpVisitsService } from './visits.service';

const TICK_MS = 60_000;

/**
 * The reception kiosk's time-based work (R33): every minute, a few paid visits still missing their token or bill are
 * finished, so a failed bill step is retried even when nobody has the Token Queue open. The pass logs its own failure and
 * is skipped while the previous one is still running, so one failed pass never stops the timer.
 */
@Injectable()
export class ReceptionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ReceptionScheduler');
  private tickTimer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly visits: OpVisitsService) {}

  onApplicationBootstrap() {
    this.tickTimer = setInterval(() => void this.tick(), TICK_MS);
    this.tickTimer.unref();
  }

  onModuleDestroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  /** The minute pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.visits.finishStuck();
    } catch (e) {
      this.logger.error(`Finishing stuck kiosk visits failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
