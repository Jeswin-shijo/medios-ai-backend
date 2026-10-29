import type { Actor } from '../beds/actor';
import type { UserRole } from '../users/schemas/user.schema';

export type AgentKey =
  | 'coordinator'
  | 'er'
  | 'bed'
  | 'lab'
  | 'pharmacy'
  | 'discharge'
  | 'scheduling'
  | 'revenue'
  | 'patient-support';

/** The nine agents in the client's order, with their job from the agent plan. */
export const AGENTS: { key: AgentKey; name: string; job: string }[] = [
  { key: 'coordinator', name: 'Coordinator', job: 'Opens and closes the case, routes messages between agents, runs the deadline clocks, escalates when something is stuck' },
  { key: 'er', name: 'ER', job: 'Emergency registration, triage support, pathway timers (such as "ECG within 10 minutes"), the ER board and task list' },
  { key: 'bed', name: 'Bed', job: 'Assigns beds, handles transfers and cleaning' },
  { key: 'lab', name: 'Lab', job: 'Turns test orders into sample tasks, tracks turnaround, delivers results, reports critical values, times repeat tests' },
  { key: 'pharmacy', name: 'Pharmacy', job: 'Checks every order (allergy, interactions, dose for weight and kidneys), queues it for the pharmacist, tracks stock, prepares take-home medicines' },
  { key: 'discharge', name: 'Discharge', job: 'Plans discharge from day one, runs the discharge checklist, drafts the summary for the doctor to sign' },
  { key: 'scheduling', name: 'Scheduling', job: 'Books procedures, consults, tests and follow-ups; manages cath lab and OPD slots and the duty roster; feeds the token queue' },
  { key: 'revenue', name: 'Revenue', job: 'Estimates, insurance pre-authorisation, charge capture, running bill, final bill, payment, claim' },
  { key: 'patient-support', name: 'Patient Support', job: 'Talks to the patient and family: calls, messages, updates, reminders, check-up calls after going home' },
];

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export type PayloadField = 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'object';

export interface MessageTypeDef {
  type: string;
  agent: AgentKey;
  description: string;
  payload: Record<string, PayloadField>;
}

export interface AgentMessageInput {
  case?: string | null;
  from: AgentKey;
  to: AgentKey[];
  type: string;
  priority: Priority;
  summary: string;
  payload?: Record<string, unknown>;
  dueBy?: Date | null;
  needsPerson?: boolean;
  opensWork?: boolean;
  resolves?: string;
  causedBy?: string;
  dedupeKey?: string;
}

export interface ClockDef {
  key: string;
  agent: AgentKey;
  label: string;
  startOn: string;
  stopOn: string[];
  minutes: number;
  ladder: string;
  /** A clock starts, stops or moves only for messages this accepts; absent means all. */
  match?: (type: string, payload: Record<string, unknown>) => boolean;
  /** The start message sets the due time; null (or an invalid date) falls back to `minutes`. */
  dueFrom?: (payload: Record<string, unknown>) => Date | null;
  /** Names the item a clock belongs to, so one case can run several clocks of this kind. Null (or a failure) means no ref. */
  refFrom?: (type: string, payload: Record<string, unknown>) => string | null;
  /** Messages that move a running clock's due time to `dueFrom(payload)`. */
  updateOn?: string[];
}

export interface ApprovalTypeDef {
  type: string;
  agent: AgentKey;
  roles: UserRole[];
  primary: { kind: 'approve' | 'open'; label: string };
  onDecision?: (approvalId: string, decision: 'approved' | 'rejected', actor: Actor) => Promise<void>;
}

export interface RuleDef {
  key: string;
  agent: AgentKey;
  label: string;
  description: string;
  default: boolean;
  locked?: boolean;
  settingPath?: string;
}

/** 'n/a': this agent has nothing to say about the case, so it neither blocks nor closes it. */
export type CloseCheckResult = 'pass' | 'fail' | 'n/a';

export interface CloseCheck {
  agent: AgentKey;
  label: string;
  /** true = pass, false = fail (for existing callers). */
  check: (caseId: string) => Promise<CloseCheckResult | boolean>;
}

export interface AgentStatusReport {
  open: number;
  capacity: number;
  onTimePct: number | null;
}

export interface RequestTypeDef {
  key: string;
  label: string;
  agent: AgentKey;
}

export interface AgentDefinition {
  key: AgentKey;
  messageTypes: MessageTypeDef[];
  handles?: { type: string; handler: (messageId: string) => Promise<void> }[];
  clocks?: ClockDef[];
  approvalTypes?: ApprovalTypeDef[];
  rules?: RuleDef[];
  closeChecks?: CloseCheck[];
  requestTypes?: RequestTypeDef[];
  status: () => Promise<AgentStatusReport>;
}

/** Rules shown as "Coming with the ... Agent" until that agent is built. */
export const COMING_RULES: { key: string; agent: AgentKey; label: string }[] = [
  { key: 'discharge-dependency-checks', agent: 'discharge', label: 'Discharge dependency checks' },
];

const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

const FIELD_CHECKS: Record<PayloadField, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  // A Date, or an ISO string once the message has been through JSON.
  date: (v) => (v instanceof Date && !isNaN(v.getTime())) || (typeof v === 'string' && !isNaN(Date.parse(v))),
  'string[]': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  object: isObject,
};

/** One error string per missing or wrongly typed field; empty when the payload fits. */
export function validatePayload(def: MessageTypeDef, payload: Record<string, unknown> | undefined): string[] {
  const errors: string[] = [];
  for (const [field, kind] of Object.entries(def.payload)) {
    const value = payload?.[field];
    if (value === undefined || value === null) errors.push(`${def.type}: "${field}" is missing`);
    else if (!FIELD_CHECKS[kind](value)) errors.push(`${def.type}: "${field}" must be ${kind}`);
  }
  return errors;
}
