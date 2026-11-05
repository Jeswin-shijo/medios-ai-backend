import type { AgentKey } from '../coordinator/coordinator-types';

/** The kinds a doctor's order can have. */
export const DISCHARGE_KINDS = ['home', 'transfer', 'against-advice', 'died'] as const;
export type DischargeKind = (typeof DISCHARGE_KINDS)[number];

/** How a plan can end: an order's kind, or a patient who left without discharge (never an order kind). */
export const COMPLETION_KINDS = [...DISCHARGE_KINDS, 'left-without-discharge'] as const;
export type CompletionKind = (typeof COMPLETION_KINDS)[number];

export const KIND_LABEL: Record<CompletionKind, string> = {
  home: 'Home',
  transfer: 'Transfer',
  'against-advice': 'Against advice',
  died: 'Died',
  'left-without-discharge': 'Left without discharge',
};

/** The condition at discharge (not asked for Died). */
export const CONDITIONS = ['improved', 'stable', 'unchanged', 'deteriorated'] as const;
export type Condition = (typeof CONDITIONS)[number];

/** The checklist lines, in the order the panel shows them. */
export const LINE_KEYS = ['order', 'summary', 'lab', 'take-home', 'follow-up', 'ama-form', 'teaching', 'death-certificate', 'body-handover', 'bill'] as const;
export type LineKey = (typeof LINE_KEYS)[number];

const LABELS: Record<LineKey, string> = {
  order: 'Discharge order',
  summary: 'Summary signed',
  lab: 'Lab results',
  'take-home': 'Take-home medicines',
  'follow-up': 'Follow-up',
  'ama-form': 'Against-advice form signed',
  teaching: 'Teaching and documents',
  'death-certificate': 'Cause-of-death certificate',
  'body-handover': 'Body handed over',
  bill: 'Nothing due on the bill',
};

/** A line's label for a kind: a transfer or an against-advice discharge hands over documents only. */
export const LINE_LABEL = (key: LineKey, kind: DischargeKind): string =>
  key === 'teaching' && (kind === 'transfer' || kind === 'against-advice') ? 'Documents handed over' : LABELS[key];

/** Who decides a line: the doctor or a nurse ticks it, or the agent (by its key) whose records it is read from. */
export type LineOwner = 'doctor' | 'nurse' | Extract<AgentKey, 'lab' | 'pharmacy' | 'scheduling' | 'revenue'>;

export const LINE_OWNER: Record<LineKey, LineOwner> = {
  order: 'doctor',
  summary: 'doctor',
  lab: 'lab',
  'take-home': 'pharmacy',
  'follow-up': 'scheduling',
  'ama-form': 'nurse',
  teaching: 'nurse',
  'death-certificate': 'doctor',
  'body-handover': 'nurse',
  bill: 'revenue',
};

/** R = required; O = optional (shown only when filled, never blocks); S = shown, never blocks; - = not shown. */
export type LineRule = 'R' | 'O' | 'S' | '-';

export const LINE_RULE: Record<DischargeKind, Record<LineKey, LineRule>> = {
  home: {
    order: 'R', summary: 'R', lab: 'R', 'take-home': 'R', 'follow-up': 'R',
    'ama-form': '-', teaching: 'R', 'death-certificate': '-', 'body-handover': '-', bill: 'R',
  },
  transfer: {
    order: 'R', summary: 'R', lab: 'R', 'take-home': 'R', 'follow-up': '-',
    'ama-form': '-', teaching: 'R', 'death-certificate': '-', 'body-handover': '-', bill: 'S',
  },
  'against-advice': {
    order: 'R', summary: 'R', lab: '-', 'take-home': 'O', 'follow-up': 'O',
    'ama-form': 'R', teaching: 'R', 'death-certificate': '-', 'body-handover': '-', bill: 'R',
  },
  died: {
    order: 'R', summary: 'R', lab: '-', 'take-home': '-', 'follow-up': '-',
    'ama-form': '-', teaching: '-', 'death-certificate': 'R', 'body-handover': 'R', bill: 'S',
  },
};

/** The summary's title for each kind, also the Documents record's title. */
export const SUMMARY_TITLE: Record<DischargeKind, string> = {
  home: 'Discharge summary',
  transfer: 'Transfer letter',
  'against-advice': 'Against-advice note',
  died: 'Death summary',
};

export type SummarySection =
  | 'details'
  | 'reason'
  | 'diagnosis'
  | 'course'
  | 'procedures'
  | 'results'
  | 'condition'
  | 'medicines'
  | 'followUp'
  | 'warningSigns'
  | 'receivingHospital'
  | 'transferReason'
  | 'timeOfDeath'
  | 'causeOfDeath';

/**
 * The sections in print order. A transfer letter has the receiving hospital and the reason in place of the
 * follow-up; a death summary has the time and cause of death in place of the condition, and no medicines,
 * follow-up or warning signs.
 */
const SECTIONS: Record<DischargeKind, readonly SummarySection[]> = {
  home: ['details', 'reason', 'diagnosis', 'course', 'procedures', 'results', 'condition', 'medicines', 'followUp', 'warningSigns'],
  transfer: ['details', 'reason', 'diagnosis', 'course', 'procedures', 'results', 'condition', 'medicines', 'receivingHospital', 'transferReason', 'warningSigns'],
  'against-advice': ['details', 'reason', 'diagnosis', 'course', 'procedures', 'results', 'condition', 'medicines', 'followUp', 'warningSigns'],
  died: ['details', 'reason', 'diagnosis', 'course', 'procedures', 'results', 'timeOfDeath', 'causeOfDeath'],
};

export const SUMMARY_SECTIONS = (kind: DischargeKind): SummarySection[] => [...SECTIONS[kind]];

export const DEFAULT_WARNING_SIGNS =
  'Come back to the hospital at once, or call us, if you have: chest pain or breathlessness; fever above 101°F (38.3°C); bleeding, or a wound that is red, swollen or leaking; severe pain not eased by your medicines; vomiting that stops you keeping medicines down; fainting, confusion, or new weakness of the face, arm or leg.';

/** Settings → Discharge. */
export interface DischargeConfig {
  /** The order-to-leaving target, in minutes (30 to 720). */
  leaveMinutes: number;
  /** The summary-signed target from the window's start, in minutes (15 to 480). */
  summaryMinutes: number;
  /** When the morning reminder is raised on the target day: HH:MM, 24-hour clinic time. */
  reminderTime: string;
  /** The default warning-signs text of a summary (1 to 1000 characters). */
  warningSigns: string;
  /** The gate pass's header line, at most 120 characters (empty by default). */
  gatePassHeader: string;
}

export const DEFAULT_DISCHARGE_CONFIG: Readonly<DischargeConfig> = Object.freeze({
  leaveMinutes: 120,
  summaryMinutes: 60,
  reminderTime: '09:00',
  warningSigns: DEFAULT_WARNING_SIGNS,
  gatePassHeader: '',
});
