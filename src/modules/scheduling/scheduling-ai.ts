import { Injectable, Logger } from '@nestjs/common';
import { StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';

const TEXT_MAX = 500;

export interface SummaryResult {
  text: string;
  sample: boolean;
  source: 'ai' | 'rules';
}

/** What the AI is told: counts only, under fixed keys. No name, UHID, number, staff name or free text. */
export interface SummaryInput {
  appointmentsByDepartment: Record<string, number>;
  avgWaitMin: number;
  conflictsByKind: Record<string, number>;
  waitlist: number;
  roomUsePctByKind: Record<string, number>;
  /** "priority/status" → count. */
  consultsByPriorityStatus: Record<string, number>;
}

/** No phone-like number, database id, UHID, PR-/CO- number, case number or staff title may go out or come back. */
export const leaks = (s: string): boolean =>
  /\d{9,}/.test(s) || /[a-f\d]{24}/i.test(s) || /\bPR-/i.test(s) || /\bCO-/i.test(s) || /MHK/i.test(s) || /\bCASE-/i.test(s) || /\bDr\./i.test(s);

export function validateSummary(raw: unknown): { text: string } | null {
  const text = typeof (raw as { text?: unknown } | null)?.text === 'string' ? (raw as { text: string }).text.trim() : '';
  return text && text.length <= TEXT_MAX && !leaks(text) ? { text } : null;
}

const sum = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The fixed sentence used when the AI is off, slow or invalid, and in sample mode. */
export function templateSummary(i: SummaryInput): string {
  const appts = sum(i.appointmentsByDepartment);
  const parts = [
    `${plural(appts, 'appointment')} today${appts ? `, average wait ${i.avgWaitMin} min` : ''}`,
    plural(sum(i.conflictsByKind), 'conflict') + ' open',
    `${i.waitlist} on the waitlist`,
    plural(sum(i.consultsByPriorityStatus), 'open consult'),
  ];
  return `${parts.join('; ')}.`;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};

const INSTRUCTIONS =
  "Summarise today's hospital schedule in two or three plain sentences for the scheduling desk, using only the counts given: appointments, waiting time, room use, conflicts, waitlist and consults. " +
  `Stay under ${TEXT_MAX} characters. Do not give orders or advice about individual people, and do not diagnose. ` +
  'Do not include names, ids, order numbers or numbers that identify a person.';

/** "Summarise today": the AI writes one short paragraph from counts. It never sets or changes a booking. */
@Injectable()
export class SchedulingAiService {
  private readonly logger = new Logger(SchedulingAiService.name);

  constructor(private readonly ai: AiService) {}

  async summarise(input: SummaryInput): Promise<SummaryResult> {
    const template = templateSummary(input);
    // Department labels are set by the hospital; if one ever looked like an identifier, nothing is sent.
    if (leaks(JSON.stringify(input))) return { text: template, sample: false, source: 'rules' };
    const task: StructuredTask<{ text: string }> = {
      feature: 'schedulingSummary',
      instructions: INSTRUCTIONS,
      input: { ...input },
      schema: SCHEMA,
      validate: validateSummary,
      sample: () => ({ text: template }),
    };
    try {
      const res = await this.ai.runStructured(task);
      if (res.ok) {
        const value = validateSummary(res.value);
        if (value) return { text: value.text, sample: res.sample, source: 'ai' };
      }
    } catch (e) {
      this.logger.warn(`Scheduling AI request failed (${e instanceof Error ? e.name : typeof e}); using the fixed sentence`);
    }
    return { text: template, sample: false, source: 'rules' };
  }
}
