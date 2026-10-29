import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CasesService } from './cases.service';
import { ClocksService } from './clocks.service';
import { AgentStatusService } from './agent-status.service';
import { CoordinatorOverviewService } from './coordinator-overview.service';
import { EscalationsService } from './escalations.service';
import { MessagesService } from './messages.service';

const TICK_MS = 30_000;
const HOUR_MS = 3_600_000;
/** After the hour turns, so a timer that fires a little early still lands in the new hour. */
const SNAPSHOT_MARGIN_MS = 1000;

/** Milliseconds from `now` to the next full (real) hour, plus the margin. */
export const untilNextSnapshot = (now: number): number => HOUR_MS - (now % HOUR_MS) + SNAPSHOT_MARGIN_MS;

/**
 * Drives the Coordinator's time-based work: one pass at start-up, then every 30 seconds
 * (clocks, escalations, agent status, case close checks, redelivery), and an hourly snapshot.
 * A pass that is still running makes the next one skip; every step logs its own failure.
 */
@Injectable()
export class CoordinatorScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CoordinatorScheduler');
  private tickTimer?: NodeJS.Timeout;
  private alignTimer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly messages: MessagesService,
    private readonly cases: CasesService,
    private readonly clocks: ClocksService,
    private readonly escalations: EscalationsService,
    private readonly agentStatus: AgentStatusService,
    private readonly overview: CoordinatorOverviewService,
  ) {}

  onApplicationBootstrap() {
    // Start-up sequence in the specified order; the first tick runs it without blocking boot.
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

  private async start() {
    if (this.running) return;
    this.running = true;
    try {
      await this.step('Default ladders and titles', () => this.escalations.ensureDefaults());
      await this.step('Redelivery', () => this.messages.redeliverPending());
      await this.sweep();
      await this.snapshot();
    } finally {
      this.running = false;
    }
  }

  private async sweep() {
    await this.step('Clock check', () => this.clocks.checkDue(new Date()));
    await this.step('Escalation check', () => this.escalations.advanceDue(new Date()));
    await this.step('Agent status poll', () => this.agentStatus.poll(new Date()));
    await this.step('Case close check', () => this.cases.evaluateOpenCases());
  }

  /** One 30-second pass; skipped while the previous one is still running. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.step('Redelivery', () => this.messages.redeliverPending());
      await this.sweep();
    } finally {
      this.running = false;
    }
  }

  private snapshot() {
    return this.step('Coordinator snapshot', () => this.overview.snapshot());
  }
}
