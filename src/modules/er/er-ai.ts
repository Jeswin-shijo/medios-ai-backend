import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { VitalsRecord, VitalsRecordDocument } from '../vitals/schemas/vitals.schema';
import { COMPLAINTS, ComplaintKey, PATHWAYS, PathwayKey, StepKey, TriageColour, TriageVitals } from './er-rules';
import { ErVisit, ErVisitDocument } from './schemas/er-visit.schema';

const EXPLAIN_MAX = 200;
const HANDOVER_MAX = 600;
const MIN_MS = 60_000;

export interface ErAiText {
  text: string;
  sample: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const complaintLabel = (key: string) => COMPLAINTS.find((c) => c.key === key)?.label ?? key;
const has = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The AI's text must be short and carry no phone-like number or database id. */
const textValidator = (max: number) => (raw: unknown): { text: string } | null => {
  const text = typeof (raw as any)?.text === 'string' ? (raw as any).text.trim() : '';
  if (!text || text.length > max) return null;
  if (/\d{9,}/.test(text) || /[a-f\d]{24}/i.test(text)) return null;
  return { text };
};

const TEXT_SCHEMA = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } };

/** Joins whole items while the result fits; the first item is hard-cut if even it does not fit. */
function fit(head: string, items: string[], sep: string, tail: string, max: number): string {
  let out = '';
  for (const item of items) {
    const next = out ? `${out}${sep}${item}` : item;
    if (`${head}${next}${tail}`.length > max) break;
    out = next;
  }
  if (!out && items[0]) out = items[0].slice(0, Math.max(0, max - head.length - tail.length));
  return `${head}${out}${tail}`;
}

/** Only these facts ever reach the AI. Built from a whitelist, never by spreading the visit. */
export interface HandoverFacts {
  complaint: string;
  colour?: TriageColour;
  vitals: { spo2?: number; bpSystolic?: number; bpDiastolic?: number; heartRate?: number; respiratoryRate?: number; temperature?: number };
  painScore?: number;
  pathways: { label: string; steps: { label: string; minutes: number }[] }[];
  doctorSeen: boolean;
  doctorSeenMinutes?: number;
  disposition?: string;
}

function vitalsSentence(f: HandoverFacts): string {
  const v = f.vitals;
  const parts: string[] = [];
  if (has(v.spo2)) parts.push(`SpO₂ ${v.spo2}%`);
  if (has(v.bpSystolic)) parts.push(`BP ${v.bpSystolic}${has(v.bpDiastolic) ? `/${v.bpDiastolic}` : ''}`);
  if (has(v.heartRate)) parts.push(`heart rate ${v.heartRate}`);
  if (has(v.respiratoryRate)) parts.push(`respiratory rate ${v.respiratoryRate}`);
  if (has(v.temperature)) parts.push(`temperature ${v.temperature}`);
  if (has(f.painScore)) parts.push(`pain ${f.painScore}/10`);
  return parts.length ? `Vitals: ${parts.join(', ')}.` : '';
}

export function handoverTemplate(f: HandoverFacts): string {
  const sentences = [`The patient came in with ${f.complaint.toLowerCase()}${f.colour ? ` and was triaged ${cap(f.colour)}` : ''}.`];
  const vit = vitalsSentence(f);
  if (vit) sentences.push(vit);
  for (const p of f.pathways) {
    sentences.push(p.steps.length ? `${p.label} pathway: ${p.steps.map((s) => `${s.label} at ${s.minutes} min`).join(', ')}.` : `${p.label} pathway running.`);
  }
  if (f.doctorSeen) sentences.push(has(f.doctorSeenMinutes) ? `Seen by a doctor at ${f.doctorSeenMinutes} min.` : 'Seen by a doctor.');
  if (f.disposition) sentences.push(`Disposition: ${f.disposition}.`);
  let out = '';
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > HANDOVER_MAX) break;
    out = next;
  }
  return out || sentences[0].slice(0, HANDOVER_MAX);
}

export function explainTemplate(colour: TriageColour, reasons: string[]): string {
  return fit(`Suggested ${cap(colour)} because `, reasons, '; ', '.', EXPLAIN_MAX);
}

/** The AI explains a triage suggestion and drafts the handover. The rules decide; people edit. Any failure gives the template. */
@Injectable()
export class ErAiService {
  constructor(
    private readonly ai: AiService,
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
    @InjectModel(VitalsRecord.name) private readonly vitals: Model<VitalsRecordDocument>,
  ) {}

  /** One sentence on why the rules suggested this colour. Never changes the colour. */
  async explainTriage(input: { colour: TriageColour; reasons: string[]; complaint: ComplaintKey; vitals: TriageVitals }): Promise<ErAiText> {
    const template = explainTemplate(input.colour, input.reasons);
    const v = input.vitals ?? {};
    const facts = {
      complaint: complaintLabel(input.complaint),
      colour: input.colour,
      reasons: input.reasons,
      vitals: {
        ...(has(v.spo2) ? { spo2: v.spo2 } : {}),
        ...(has(v.bpSystolic) ? { bpSystolic: v.bpSystolic } : {}),
        ...(has(v.heartRate) ? { heartRate: v.heartRate } : {}),
        ...(has(v.respiratoryRate) ? { respiratoryRate: v.respiratoryRate } : {}),
        ...(has(v.temperature) ? { temperature: v.temperature } : {}),
      },
    };
    return this.run(
      'Explain in one short sentence (under 200 characters) why the emergency triage rules suggested this colour, using only the facts given. Do not give a diagnosis, change the colour or advise treatment. Do not include names, ids or phone numbers.',
      facts,
      template,
      EXPLAIN_MAX,
    );
  }

  /** A short handover note for the nurse to edit before it fills the bed request. */
  async draftHandover(visitId: string): Promise<ErAiText> {
    if (!isValidObjectId(visitId)) throw new NotFoundException('ER visit not found');
    const visit = await this.visits.findById(visitId).lean().exec();
    if (!visit) throw new NotFoundException('ER visit not found');
    const record = visit.vitalsId && isValidObjectId(visit.vitalsId) ? await this.vitals.findById(visit.vitalsId).lean().exec() : null;

    // The readings kept on the visit come first; the Vitals record fills only what is missing.
    const reading: Record<string, unknown> = { ...(record ?? {}), ...(visit.vitals ?? {}) };

    const arrived = new Date(visit.arrivedAt).getTime();
    const minutes = (d: Date) => Math.max(0, Math.round((new Date(d).getTime() - arrived) / MIN_MS));

    const latest = new Map<string, any>();
    for (const p of visit.pathways ?? []) latest.set(p.key, p);
    const running = [...latest.values()].filter((p) => !p.cancelled).map((p) => p.key as PathwayKey);
    const done = new Map<StepKey, Date>();
    for (const s of visit.steps ?? []) if (s.doneAt) done.set(s.key, s.doneAt);

    const facts: HandoverFacts = {
      complaint: complaintLabel(visit.complaint),
      ...(visit.triage?.colour ? { colour: visit.triage.colour as TriageColour } : {}),
      vitals: {
        ...(has(reading.spo2) ? { spo2: reading.spo2 } : {}),
        ...(has(reading.bpSystolic) ? { bpSystolic: reading.bpSystolic } : {}),
        ...(has(reading.bpDiastolic) ? { bpDiastolic: reading.bpDiastolic } : {}),
        ...(has(reading.heartRate) ? { heartRate: reading.heartRate } : {}),
        ...(has(reading.respiratoryRate) ? { respiratoryRate: reading.respiratoryRate } : {}),
        ...(has(reading.temperature) ? { temperature: reading.temperature } : {}),
      },
      ...(has(visit.painScore) ? { painScore: visit.painScore } : {}),
      pathways: running.map((key) => ({
        label: PATHWAYS[key].label,
        steps: PATHWAYS[key].steps
          .filter((s) => s.key !== 'doctor' && done.has(s.key))
          .map((s) => ({ label: s.label, minutes: minutes(done.get(s.key)!) })),
      })),
      doctorSeen: !!visit.doctorSeenAt,
      ...(visit.doctorSeenAt ? { doctorSeenMinutes: minutes(visit.doctorSeenAt) } : {}),
      ...(visit.disposition?.kind ? { disposition: visit.disposition.kind } : {}),
    };

    return this.run(
      'Draft a plain handover note of at most 600 characters for the ward nurse, using only the facts given. Refer to the person as "the patient". Do not give a diagnosis or advise treatment. Do not include names, ids or phone numbers.',
      facts as unknown as Record<string, unknown>,
      handoverTemplate(facts),
      HANDOVER_MAX,
    );
  }

  private async run(instructions: string, facts: Record<string, unknown>, template: string, max: number): Promise<ErAiText> {
    const task: StructuredTask<{ text: string }> = {
      feature: 'erAssist',
      instructions,
      input: { facts, template },
      schema: TEXT_SCHEMA,
      validate: textValidator(max),
      sample: () => ({ text: template }),
    };
    try {
      const res = await this.ai.runStructured(task);
      if (res.ok) {
        const value = textValidator(max)(res.value);
        if (value) return { text: value.text, sample: res.sample };
      }
    } catch {
      // fall through to the template
    }
    return { text: template, sample: false };
  }
}
