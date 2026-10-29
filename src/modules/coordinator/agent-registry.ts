import { Injectable } from '@nestjs/common';
import {
  AgentDefinition,
  AgentKey,
  ApprovalTypeDef,
  ClockDef,
  CloseCheck,
  MessageTypeDef,
  RequestTypeDef,
  RuleDef,
} from './coordinator-types';

const coordinatorType = (type: string, description: string, payload: MessageTypeDef['payload'] = {}): MessageTypeDef => ({
  type,
  agent: 'coordinator',
  description,
  payload,
});

/** The Coordinator's own definition: the messages it sends about cases, clocks and approvals. */
const COORDINATOR_DEFINITION: AgentDefinition = {
  key: 'coordinator',
  messageTypes: [
    coordinatorType('case.opened', 'A case was opened'),
    coordinatorType('case.closed', 'A case was closed'),
    coordinatorType('clock.expired', 'A deadline clock ran out', { clockKey: 'string' }),
    coordinatorType('escalation.raised', 'Something stuck was passed up to a person', { reason: 'string' }),
    coordinatorType('approval.requested', 'An agent asked a person to approve', { approvalType: 'string' }),
    coordinatorType('approval.decided', 'A person approved or rejected', { approvalType: 'string', decision: 'string' }),
  ],
  rules: [
    {
      key: 'emergency-first',
      agent: 'coordinator',
      label: 'Emergency-first routing',
      description: 'Critical and ER work is handled and listed first.',
      default: true,
      locked: true,
    },
    {
      key: 'escalate-overdue',
      agent: 'coordinator',
      label: 'Escalate overdue work',
      description: 'Overdue work climbs its escalation ladder until someone acknowledges it.',
      default: true,
      locked: true,
    },
  ],
  status: async () => ({ open: 0, capacity: 0, onTimePct: null }),
};

/** Which agents are built, and the message types, clocks, rules and checks they brought. */
@Injectable()
export class AgentRegistry {
  private readonly defs = new Map<AgentKey, AgentDefinition>();
  private readonly types = new Map<string, MessageTypeDef>();

  constructor() {
    this.register(COORDINATOR_DEFINITION);
  }

  register(def: AgentDefinition): void {
    if (this.defs.has(def.key)) throw new Error(`Agent "${def.key}" is already registered`);
    for (const t of def.messageTypes) {
      const owner = this.types.get(t.type)?.agent;
      if (t.agent !== def.key) throw new Error(`Message type "${t.type}" belongs to "${t.agent}", not "${def.key}"`);
      if (owner) throw new Error(`Message type "${t.type}" is already owned by "${owner}"`);
    }
    this.defs.set(def.key, def);
    for (const t of def.messageTypes) this.types.set(t.type, t);
  }

  definitions(): AgentDefinition[] {
    return [...this.defs.values()];
  }

  get(key: AgentKey): AgentDefinition | undefined {
    return this.defs.get(key);
  }

  isBuilt(key: AgentKey): boolean {
    return this.defs.has(key);
  }

  messageType(type: string): MessageTypeDef | undefined {
    return this.types.get(type);
  }

  subscribers(type: string): { agent: AgentKey; handler: (messageId: string) => Promise<void> }[] {
    return this.definitions().flatMap((d) =>
      (d.handles ?? []).filter((h) => h.type === type).map((h) => ({ agent: d.key, handler: h.handler })),
    );
  }

  private allClocks(): ClockDef[] {
    return this.definitions().flatMap((d) => d.clocks ?? []);
  }

  clocksStartingOn(type: string): ClockDef[] {
    return this.allClocks().filter((c) => c.startOn === type);
  }

  clocksStoppingOn(type: string): ClockDef[] {
    return this.allClocks().filter((c) => c.stopOn.includes(type));
  }

  clocksUpdatingOn(type: string): ClockDef[] {
    return this.allClocks().filter((c) => c.updateOn?.includes(type));
  }

  clock(key: string): ClockDef | undefined {
    return this.allClocks().find((c) => c.key === key);
  }

  approvalType(type: string): ApprovalTypeDef | undefined {
    return this.definitions().flatMap((d) => d.approvalTypes ?? []).find((a) => a.type === type);
  }

  rules(): RuleDef[] {
    return this.definitions().flatMap((d) => d.rules ?? []);
  }

  closeChecks(): CloseCheck[] {
    return this.definitions().flatMap((d) => d.closeChecks ?? []);
  }

  requestTypes(): RequestTypeDef[] {
    return this.definitions().flatMap((d) => d.requestTypes ?? []);
  }
}
