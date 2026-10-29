import { Injectable, Logger } from '@nestjs/common';
import { AgentRegistry } from './agent-registry';
import { CoordinatorEvents } from './coordinator-events';
import { AGENTS, AgentKey, AgentStatusReport } from './coordinator-types';

const MINUTE_MS = 60_000;
/** An agent is online when its last successful status poll is this recent. */
export const ONLINE_WITHIN_MS = 2 * MINUTE_MS;
const POLL_TIMEOUT_MS = 5_000;

export interface AgentStatusView {
  key: AgentKey;
  name: string;
  job: string;
  built: boolean;
  online: boolean;
  open: number;
  capacity: number;
  onTimePct: number | null;
}

interface LastPoll {
  at: Date;
  report: AgentStatusReport;
}

/** Asks each built agent how it is doing, and keeps the last answer. Real time. */
@Injectable()
export class AgentStatusService {
  private readonly logger = new Logger(AgentStatusService.name);
  private readonly last = new Map<AgentKey, LastPoll>();
  private readonly wasOnline = new Map<AgentKey, boolean>();

  constructor(
    private readonly registry: AgentRegistry,
    private readonly events: CoordinatorEvents,
  ) {}

  async poll(now: Date): Promise<void> {
    await Promise.all(
      this.registry.definitions().map(async (def) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('status timed out')), POLL_TIMEOUT_MS);
          });
          const report = await Promise.race([def.status(), timeout]);
          this.last.set(def.key, { at: now, report });
        } catch (err) {
          this.logger.warn(`Status poll failed for ${def.key}: ${(err as Error)?.message ?? err}`);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    for (const view of this.list(now)) {
      if (!view.built) continue;
      if (view.online !== (this.wasOnline.get(view.key) ?? false)) {
        this.events.emit({ kind: 'agent', id: view.key, summary: `${view.name} ${view.online ? 'online' : 'offline'}` });
      }
      this.wasOnline.set(view.key, view.online);
    }
  }

  list(now: Date = new Date()): AgentStatusView[] {
    return AGENTS.map(({ key, name, job }) => {
      const built = this.registry.isBuilt(key);
      const last = built ? this.last.get(key) : undefined;
      const online = !!last && now.getTime() - last.at.getTime() <= ONLINE_WITHIN_MS;
      return {
        key,
        name,
        job,
        built,
        online,
        open: last?.report.open ?? 0,
        capacity: last?.report.capacity ?? 0,
        onTimePct: last?.report.onTimePct ?? null,
      };
    });
  }
}
