import { Injectable, Logger } from '@nestjs/common';
import { AiFeature, StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { leaks as revenueLeaks } from '../revenue/revenue-ai';
import { DischargeKind, LINE_LABEL, LineKey } from './discharge-catalogue';

/** The longest answer kept; the AI is asked for less. */
const TEXT_MAX = 1000;

export interface DischargeTextResult {
  text: string;
  sample: boolean;
  source: 'ai' | 'rules';
}

export type TestFlag = 'normal' | 'abnormal' | 'critical';

/**
 * What the AI is told about a stay to write the "Course in hospital" paragraph (design 4.4 and 6): coded facts only.
 * Ward types (never ward names or beds), the hospital's own procedure and test names with their flags, counts, the
 * condition code and the length of the stay. Never a name, UHID, id, date, doctor or any typed text: not the
 * diagnosis, the admission notes or the doctor's note.
 */
export interface CourseFacts {
  kind: DischargeKind;
  /** The wards in the order the patient stayed in them, by type, with whole days (0 is less than a day). */
  wards: { type: string; days: number }[];
  /** The procedures done, by their catalogue names. */
  procedures: string[];
  /** The released tests, by their catalogue names, each with its worst flag. */
  tests: { name: string; flag: TestFlag }[];
  /** How many different medicines were given on the ward or in the ER. */
  medicineCount: number;
  /** The condition at discharge (improved, stable, unchanged, deteriorated); null for a death. */
  condition: string | null;
  /** Whole days from admission to leaving (0 is less than a day). */
  stayDays: number;
}

/** What the AI is told about the day (design 6): counts under fixed keys, and the checklist line of the longest wait. */
export interface DischargeDayCounts {
  dueToday: number;
  noOrder: number;
  clearing: number;
  ready: number;
  leftToday: number;
  /** Today's average minutes from the window opening to leaving; null when nobody has left today. */
  avgMinutes: number | null;
  /** The order-to-leaving target, in minutes (Settings → Discharge). */
  targetMinutes: number;
  /** The line the longest-waiting open discharge is held on, and for how many minutes; null when none waits. */
  longestWait: { line: LineKey; minutes: number } | null;
}

/** Revenue's patterns (which include Scheduling's), plus the gate-pass numbers. */
export const leaks = (s: string): boolean => revenueLeaks(s) || /\bGP-/i.test(s);

export function validateText(raw: unknown): { text: string } | null {
  const text = typeof (raw as { text?: unknown } | null)?.text === 'string' ? (raw as { text: string }).text.trim() : '';
  return text && text.length <= TEXT_MAX && !leaks(text) ? { text } : null;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const WARD_LABEL: Record<string, string> = {
  emergency: 'emergency ward',
  icu: 'ICU',
  hdu: 'HDU',
  isolation: 'isolation ward',
  general: 'general ward',
  paediatric: 'paediatric ward',
  maternity: 'maternity ward',
  twin: 'twin-sharing room',
  private: 'private room',
  deluxe: 'deluxe room',
};
const wardLabel = (type: string): string => WARD_LABEL[type] ?? `${type} ward`;
const days = (n: number): string => (n > 0 ? plural(n, 'day') : 'less than a day');

/**
 * The rules' paragraph, used when the AI is off, slow or refused, and as the canned sample: "Admitted to the <ward>
 * for <n> days. <Procedures>. Investigations: <tests with flags>. Treated with <n> medicines. Condition at discharge:
 * <condition>." A part the stay has none of is left out.
 */
export function templateCourse(f: CourseFacts): string {
  const parts = [
    f.wards.length
      ? `Admitted to ${f.wards.map((w, i) => `${i ? 'then ' : ''}the ${wardLabel(w.type)} for ${days(w.days)}`).join(', ')}.`
      : `Admitted for ${days(f.stayDays)}.`,
  ];
  if (f.procedures.length) parts.push(`${f.procedures.join(', ')}.`);
  if (f.tests.length) parts.push(`Investigations: ${f.tests.map((t) => `${t.name} (${t.flag})`).join(', ')}.`);
  if (f.medicineCount > 0) parts.push(`Treated with ${plural(f.medicineCount, 'medicine')}.`);
  if (f.condition) parts.push(`Condition at discharge: ${f.condition}.`);
  return parts.join(' ');
}

/** What the day sentence says the longest wait is on: "the longest wait is 140 min, waiting on the bill". */
const WAITING_ON: Record<LineKey, string> = {
  order: 'the discharge order',
  summary: 'the signed summary',
  lab: 'lab results',
  'take-home': 'take-home medicines',
  'follow-up': 'the follow-up booking',
  'ama-form': 'the against-advice form',
  teaching: 'teaching and documents',
  'death-certificate': 'the cause-of-death certificate',
  'body-handover': 'the body handover',
  bill: 'the bill',
};

/** The rules' sentence for the day, used when the AI is off, slow or refused, and as the canned sample. */
export function templateDaySummary(c: DischargeDayCounts): string {
  const average = c.leftToday && c.avgMinutes !== null ? `, ${c.avgMinutes} min on average from order to leaving (target ${c.targetMinutes} min)` : '';
  const parts = [
    `${c.dueToday} due today${c.noOrder ? ` (${c.noOrder} with no order yet)` : ''}`,
    `${c.clearing} clearing`,
    `${c.ready} ready to leave`,
    `${c.leftToday} left today${average}`,
  ];
  if (c.longestWait) parts.push(`the longest wait is ${c.longestWait.minutes} min, waiting on ${WAITING_ON[c.longestWait.line]}`);
  return `${parts.join('; ')}.`;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};

const COMMON =
  ' Stay under 600 characters. Use only the facts given: do not add facts, do not diagnose, and do not give advice or orders.' +
  ' Do not include names, ids, dates, bed or gate-pass numbers, or numbers that identify a person.';
const COURSE =
  'Write the "Course in hospital" paragraph of a hospital discharge summary in two to four plain sentences, from the facts given: the wards the patient stayed in and for how many days, the procedures done, the tests with their flags, how many medicines were given and the condition at discharge. The kind says how the stay ended: home, transfer, against-advice or died.' +
  COMMON;
const SUMMARISE =
  "Summarise today's discharges for the ward team in two or three plain sentences, from the counts given: due today, with no order yet, clearing, ready to leave, left today, the average time from order to leaving against the target, and the checklist line the longest wait is on." +
  COMMON;

/**
 * The Discharge Agent's AI (section 6: rules decide, the AI explains). It writes the summary's "Course in hospital"
 * paragraph from coded facts and the day summary from counts. It never decides a discharge, ticks a line or writes
 * the diagnosis, the medicines or the warning signs; the doctor edits and signs whatever it writes.
 */
@Injectable()
export class DischargeAiService {
  private readonly logger = new Logger(DischargeAiService.name);

  constructor(private readonly ai: AiService) {}

  /** The "Course in hospital" paragraph. Only the coded fields are sent, whatever else the object holds. */
  course(input: CourseFacts): Promise<DischargeTextResult> {
    const facts: CourseFacts = {
      kind: input.kind,
      wards: input.wards.map((w) => ({ type: w.type, days: w.days })),
      procedures: [...input.procedures],
      tests: input.tests.map((t) => ({ name: t.name, flag: t.flag })),
      medicineCount: input.medicineCount,
      condition: input.condition,
      stayDays: input.stayDays,
    };
    return this.run('dischargeCourse', COURSE, { ...facts }, templateCourse(facts));
  }

  /** "Summarise today" on the Discharge page: the counts, with the longest wait's line by its label. */
  daySummary(counts: DischargeDayCounts): Promise<DischargeTextResult> {
    const input = {
      dueToday: counts.dueToday,
      noOrder: counts.noOrder,
      clearing: counts.clearing,
      ready: counts.ready,
      leftToday: counts.leftToday,
      avgMinutes: counts.avgMinutes,
      targetMinutes: counts.targetMinutes,
      longestWait: counts.longestWait ? { line: LINE_LABEL(counts.longestWait.line, 'home'), minutes: counts.longestWait.minutes } : null,
    };
    return this.run('dischargeSummary', SUMMARISE, input, templateDaySummary(counts));
  }

  private async run(feature: AiFeature, instructions: string, input: Record<string, unknown>, template: string): Promise<DischargeTextResult> {
    // Names come from the hospital's catalogues; if one ever looked like an identifier, nothing is sent.
    if (leaks(JSON.stringify(input))) return { text: template, sample: false, source: 'rules' };
    const task: StructuredTask<{ text: string }> = {
      feature,
      instructions,
      input,
      schema: SCHEMA,
      validate: validateText,
      sample: () => ({ text: template }),
    };
    try {
      const res = await this.ai.runStructured(task);
      if (res.ok) {
        const value = validateText(res.value);
        if (value) return { text: value.text, sample: res.sample, source: 'ai' };
      }
    } catch (e) {
      this.logger.warn(`Discharge AI request failed (${e instanceof Error ? e.name : typeof e}); using the rules' text`);
    }
    return { text: template, sample: false, source: 'rules' };
  }
}
