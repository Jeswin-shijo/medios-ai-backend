import { Injectable, Logger } from '@nestjs/common';
import { AiFeature, StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { leaks as dischargeLeaks } from '../discharge/discharge-ai';

/** The longest answer kept; the AI is asked for less. */
const TEXT_MAX = 1000;

export interface SupportTextResult {
  text: string;
  sample: boolean;
  source: 'ai' | 'rules';
}

/** What the AI is told about the day: counts only, under fixed keys. */
export interface SupportDayCounts {
  ticketsOpened: number;
  ticketsResolved: number;
  ticketsEscalated: number;
  updatesSent: number;
  updatesSkipped: number;
  updatesHeld: number;
  checkupsDone: number;
  needsDoctor: number;
  sentToEr: number;
  /** The 7-day average rating; null when there is none. */
  averageRating: number | null;
}

/** Discharge's patterns (which chain Revenue's and Scheduling's), plus ticket and check-up numbers. */
export const leaks = (s: string): boolean => dischargeLeaks(s) || /\b(?:SP|CU)-/i.test(s);

export function validateText(raw: unknown): { text: string } | null {
  const text = typeof (raw as { text?: unknown } | null)?.text === 'string' ? (raw as { text: string }).text.trim() : '';
  return text && text.length <= TEXT_MAX && !leaks(text) ? { text } : null;
}

/** The rules' sentence, used when the AI is off, slow or refused, and as the canned sample. */
export function templateDaySummary(c: SupportDayCounts): string {
  return `Today: ${c.ticketsOpened} questions, ${c.ticketsResolved} resolved, ${c.ticketsEscalated} escalated; ${c.updatesSent} family updates sent, ${c.updatesSkipped} skipped; ${c.checkupsDone} check-up calls done.`;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } }
};

const SUMMARISE =
  "Summarise today's patient support for the front-desk team in two or three plain sentences, from the counts given: questions opened, resolved and escalated, family updates sent, skipped and held, check-up calls done, how many needed a doctor or were sent to the ER, and the 7-day average rating." +
  ' Stay under 600 characters. Use only the facts given: do not add facts, do not diagnose, and do not give advice or orders.' +
  ' Do not include names, ids, dates, ticket or check-up numbers, or numbers that identify a person.';

/** Patient Support's AI: it only writes the day summary from counts. It never answers a patient or decides anything. */
@Injectable()
export class SupportAiService {
  private readonly logger = new Logger(SupportAiService.name);

  constructor(private readonly ai: AiService) {}

  /** Only the counts are sent, whatever else the object holds. */
  daySummary(counts: SupportDayCounts): Promise<SupportTextResult> {
    const input = {
      ticketsOpened: counts.ticketsOpened,
      ticketsResolved: counts.ticketsResolved,
      ticketsEscalated: counts.ticketsEscalated,
      updatesSent: counts.updatesSent,
      updatesSkipped: counts.updatesSkipped,
      updatesHeld: counts.updatesHeld,
      checkupsDone: counts.checkupsDone,
      needsDoctor: counts.needsDoctor,
      sentToEr: counts.sentToEr,
      averageRating: counts.averageRating
    };
    return this.run('supportSummary', SUMMARISE, input, templateDaySummary(counts));
  }

  private async run(feature: AiFeature, instructions: string, input: Record<string, unknown>, template: string): Promise<SupportTextResult> {
    if (leaks(JSON.stringify(input))) return { text: template, sample: false, source: 'rules' };
    const task: StructuredTask<{ text: string }> = {
      feature,
      instructions,
      input,
      schema: SCHEMA,
      validate: validateText,
      sample: () => ({ text: template })
    };
    try {
      const res = await this.ai.runStructured(task);
      if (res.ok) {
        const value = validateText(res.value);
        if (value) return { text: value.text, sample: res.sample, source: 'ai' };
      }
    } catch (e) {
      this.logger.warn(`Patient Support AI request failed (${e instanceof Error ? e.name : typeof e}); using the rules' text`);
    }
    return { text: template, sample: false, source: 'rules' };
  }
}
