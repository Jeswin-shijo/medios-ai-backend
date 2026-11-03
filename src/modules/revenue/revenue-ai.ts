import { Injectable, Logger } from '@nestjs/common';
import { formatRupees } from '../../common/utils/money';
import { AiFeature, StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { leaks as schedulingLeaks } from '../scheduling/scheduling-ai';

const TEXT_MAX = 500;

export interface RevenueTextResult {
  text: string;
  sample: boolean;
  source: 'ai' | 'rules';
}

/** What the AI is told about one bill: totals, counts and catalogue procedure labels. No name, UHID, number or typed text. */
export interface BillExplainInput {
  /** The category → net amount, in whole rupees. */
  categoryTotals: Record<string, number>;
  lineCountsByCategory: Record<string, number>;
  /** Labels come from the hospital's procedure catalogue, never from a line name typed by staff. */
  procedures: { label: string; amount: number }[];
  totals: { charges: number; discounts: number; payments: number; refunds: number; balance: number };
  paymentsByMode: Record<string, number>;
  billState?: string;
  billKind?: string;
  needsPriceLines?: number;
}

/** What the AI is told about the day: totals and counts under fixed keys. */
export interface RevenueSummaryInput {
  collectedToday: number;
  byMode: Record<string, number>;
  openBills: number;
  depositsDue: number;
  finalWaiting: number;
  refundsDue: number;
  needsPriceLines: number;
  openBillsByKind: Record<string, number>;
  outstandingBalance: number;
}

/**
 * The Scheduling patterns (phone-like number, database id, UHID, PR-/CO- and case numbers, "Dr.") plus the bill, receipt,
 * refund, ER-visit, lab-request and procedure-order numbers. Whole-rupee amounts are at most 8 digits, so they pass.
 */
export const leaks = (s: string): boolean => schedulingLeaks(s) || /\b(?:BL|RC|RF|ER|LR|MO)-/i.test(s);

export function validateText(raw: unknown): { text: string } | null {
  const text = typeof (raw as { text?: unknown } | null)?.text === 'string' ? (raw as { text: string }).text.trim() : '';
  return text && text.length <= TEXT_MAX && !leaks(text) ? { text } : null;
}

const rupees = (o: Record<string, number> | undefined): string =>
  Object.entries(o ?? {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${formatRupees(v)}`)
    .join(', ');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The fixed sentence used when the AI is off, slow or invalid, and in sample mode. */
export function templateExplain(i: BillExplainInput): string {
  const t = i.totals;
  const lines = Object.values(i.lineCountsByCategory ?? {}).reduce((a, b) => a + b, 0);
  const by = rupees(i.categoryTotals);
  const parts = [`Charges ${formatRupees(t.charges)}${lines ? ` across ${plural(lines, 'line')}` : ''}${by ? ` (${by})` : ''}`];
  if (t.discounts) parts.push(`discounts ${formatRupees(t.discounts)}`);
  parts.push(`paid ${formatRupees(t.payments)}`);
  if (t.refunds) parts.push(`refunded ${formatRupees(t.refunds)}`);
  parts.push(t.balance > 0 ? `balance due ${formatRupees(t.balance)}` : t.balance < 0 ? `${formatRupees(-t.balance)} to give back` : 'nothing due');
  return `${parts.join('; ')}.`;
}

export function templateSummary(i: RevenueSummaryInput): string {
  const modes = rupees(i.byMode);
  const parts = [
    `${formatRupees(i.collectedToday)} collected today${modes ? ` (${modes})` : ''}`,
    `${plural(i.openBills, 'open bill')} with ${formatRupees(i.outstandingBalance)} outstanding`,
    `${i.depositsDue} deposits due`,
    `${i.finalWaiting} final bills waiting`,
    `${i.refundsDue} refunds to pay`,
  ];
  if (i.needsPriceLines) parts.push(`${plural(i.needsPriceLines, 'line')} need a price`);
  return `${parts.join('; ')}.`;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};

const COMMON = ` Stay under ${TEXT_MAX} characters. Do not give orders or advice about individual people, and do not diagnose. Do not include names, ids, bill, receipt or refund numbers, or numbers that identify a person.`;
const EXPLAIN =
  'Explain in two or three plain sentences how this hospital bill adds up for the patient, using only the totals, counts and procedures given: what the charges are, what has been paid, and what is left.' + COMMON;
const SUMMARISE =
  "Summarise today's billing for the front desk in two or three plain sentences, using only the totals and counts given: money collected, open bills, deposits, final bills, refunds and lines that need a price." + COMMON;

/** "Explain this bill" and "Summarise today": the AI writes one short paragraph from totals. It never changes a bill. */
@Injectable()
export class RevenueAiService {
  private readonly logger = new Logger(RevenueAiService.name);

  constructor(private readonly ai: AiService) {}

  explain(input: BillExplainInput): Promise<RevenueTextResult> {
    return this.run('revenueExplain', EXPLAIN, input as unknown as Record<string, unknown>, templateExplain(input));
  }

  summarise(input: RevenueSummaryInput): Promise<RevenueTextResult> {
    return this.run('revenueSummary', SUMMARISE, input as unknown as Record<string, unknown>, templateSummary(input));
  }

  private async run(feature: AiFeature, instructions: string, input: Record<string, unknown>, template: string): Promise<RevenueTextResult> {
    // Labels are set by the hospital; if one ever looked like an identifier, nothing is sent.
    if (leaks(JSON.stringify(input))) return { text: template, sample: false, source: 'rules' };
    const task: StructuredTask<{ text: string }> = {
      feature,
      instructions,
      input: { ...input },
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
      this.logger.warn(`Revenue AI request failed (${e instanceof Error ? e.name : typeof e}); using the fixed sentence`);
    }
    return { text: template, sample: false, source: 'rules' };
  }
}
