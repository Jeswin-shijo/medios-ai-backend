import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { rangeText, testByKey } from './lab-catalogue';
import { LabLine, LabLineDocument } from './schemas/lab-line.schema';
import { LabRequest, LabRequestDocument } from './schemas/lab-request.schema';

const FINDINGS_MAX = 6;
const RECOMMENDATIONS_MAX = 4;
const ITEM_MAX = 160;
const INTERPRETATION_MAX = 300;

export interface LabSummary {
  findings: string[];
  interpretation: string;
  recommendations: string[];
}
export interface LabSummaryResult extends LabSummary {
  sample: boolean;
}

/** One parameter as the AI and the template see it. */
export interface LabFact {
  name: string;
  value: string | number;
  unit: string;
  referenceRange: string;
  flag: 'normal' | 'low' | 'high' | 'abnormal';
  critical: boolean;
}

const line = (f: LabFact) => `${[f.name, f.value, f.unit].filter((x) => x !== '').join(' ')} — ${f.flag}${f.critical ? ' (critical)' : ''}`;

/** The fixed summary used when the AI is off, slow or invalid: abnormal values, critical first. */
export function templateSummary(facts: LabFact[]): LabSummary {
  const abnormal = facts.filter((f) => f.flag !== 'normal' || f.critical).sort((a, b) => Number(b.critical) - Number(a.critical));
  const critical = abnormal.filter((f) => f.critical).length;
  return {
    findings: abnormal.length ? abnormal.map(line) : ['All values within the reference range.'],
    interpretation: abnormal.length ? `${abnormal.length} value(s) outside the reference range; ${critical} critical.` : 'No abnormal values.',
    recommendations: ['Review with the clinical picture.', ...(critical ? ['Critical value — confirm the doctor has acknowledged it.'] : [])],
  };
}

/** No phone-like number, database id, UHID, request or sample number may come back from the AI. */
const leaks = (s: string) => /\d{9,}/.test(s) || /[a-f\d]{24}/i.test(s) || /\bLR-\d+/.test(s) || /\bS-\d{6}-\d{4}/.test(s) || /MHK\d+/i.test(s);

function items(raw: unknown, max: number): string[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const out: string[] = [];
  for (const r of raw) {
    const t = typeof r === 'string' ? r.trim() : '';
    if (!t || t.length > ITEM_MAX || leaks(t)) return null;
    out.push(t);
  }
  return out;
}

export function validateSummary(raw: unknown): LabSummary | null {
  const r = raw as Partial<LabSummary> | null;
  const findings = items(r?.findings, FINDINGS_MAX);
  const recommendations = items(r?.recommendations, RECOMMENDATIONS_MAX);
  const interpretation = typeof r?.interpretation === 'string' ? r.interpretation.trim() : '';
  if (!findings || !recommendations || !interpretation || interpretation.length > INTERPRETATION_MAX || leaks(interpretation)) return null;
  return { findings, interpretation, recommendations };
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'interpretation', 'recommendations'],
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
    interpretation: { type: 'string' },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};

const INSTRUCTIONS =
  'Summarise this released laboratory result for the treating doctor, using only the values given. ' +
  `Give at most ${FINDINGS_MAX} short findings (under ${ITEM_MAX} characters each), one plain interpretation sentence (under ${INTERPRETATION_MAX} characters) ` +
  `and at most ${RECOMMENDATIONS_MAX} short suggestions. Do not diagnose or prescribe. Do not include names, ids, numbers that identify a person or phone numbers.`;

const sexOf = (g: unknown): 'M' | 'F' | 'Other' | null => {
  const s = typeof g === 'string' ? g.trim().toLowerCase() : '';
  return s === 'male' || s === 'm' ? 'M' : s === 'female' || s === 'f' ? 'F' : s ? 'Other' : null;
};

/** The AI summarises a released result for the doctor. It only ever sees the values, age and sex. */
@Injectable()
export class LabAiService {
  private readonly logger = new Logger(LabAiService.name);

  constructor(
    private readonly ai: AiService,
    @InjectModel(LabLine.name) private readonly lines: Model<LabLineDocument>,
    @InjectModel(LabRequest.name) private readonly requests: Model<LabRequestDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>,
  ) {}

  async summarise(lineId: string): Promise<LabSummaryResult> {
    const found = isValidObjectId(lineId) ? await this.lines.findById(lineId).lean().exec() : null;
    if (!found) throw new NotFoundException('Lab test not found');
    const def = testByKey(found.test);
    const request = await this.requests.findById(found.request).lean().exec();
    const patient = request ? await this.patients.findOne({ uhid: request.patientUhid }).select('age gender').lean().exec() : null;

    const facts: LabFact[] = found.results.map((r) => ({
      name: r.param,
      value: r.value,
      unit: r.unit,
      referenceRange: def ? rangeText(def.key, def.params.find((p) => p.name === r.param) ?? { name: r.param, unit: r.unit }) : '',
      flag: r.flag,
      critical: r.critical,
    }));
    const template = templateSummary(facts);
    // Built from a whitelist, never by spreading the line, request or patient.
    const input = {
      test: def?.label ?? found.test,
      parameters: facts.map((f) => ({ name: f.name, value: f.value, unit: f.unit, referenceRange: f.referenceRange, flag: f.flag, critical: f.critical })),
      patient: { age: typeof patient?.age === 'number' ? patient.age : null, sex: sexOf(patient?.gender) },
    };

    const task: StructuredTask<LabSummary> = { feature: 'labSummary', instructions: INSTRUCTIONS, input, schema: SCHEMA, validate: validateSummary, sample: () => template };
    try {
      const res = await this.ai.runStructured(task);
      if (res.ok) {
        const value = validateSummary(res.value);
        if (value) return { ...value, sample: res.sample };
      }
    } catch (e) {
      // Only the kind of failure: the message could carry what was sent.
      this.logger.warn(`Lab AI request failed (${e instanceof Error ? e.name : typeof e}); using the template`);
    }
    return { ...template, sample: false };
  }
}
