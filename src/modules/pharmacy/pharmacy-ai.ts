import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { StructuredTask } from '../ai/ai-types';
import { AiService } from '../ai/ai.service';
import { DOSES_PER_DAY, ROUTE_LABEL, medicineByKey } from './pharmacy-catalogue';
import { PharmacyPatientsService } from './pharmacy-patients.service';
import type { Flag, FlagKind } from './pharmacy-rules';
import { PharmacyLine, PharmacyLineDocument } from './schemas/pharmacy-line.schema';

const TEXT_MAX = 500;
const UNLISTED = 'a medicine not in the list';

export interface ExplainResult {
  text: string;
  sample: boolean;
  source: 'ai' | 'rules';
}

/** What to do about a flag of each kind: the second half of the fixed explanation. */
export const HINTS: Record<FlagKind, string> = {
  allergy: 'Check what the reaction was and whether this medicine was taken safely before.',
  clash: 'Check that both medicines are needed together, and monitor.',
  double: 'Check that both are intended.',
  dose: 'Check the dose against the weight and the indication.',
  kidney: 'Check the latest kidney function and adjust the dose if needed.',
  age: "Check a child's dose with a paediatric reference.",
  list: 'Check this medicine by hand.',
  procedure: 'Hold metformin around the contrast dye, and check the kidney function first.',
};

/** The fixed words of a list flag, sent as they are: nothing typed by a person is ever part of them. */
const LIST_WORDS: Record<string, string> = {
  'list.unmatched': 'Not in the medicine list: checks could not run',
  'list.dose-unreadable': 'Dose not readable: check by hand',
};

/** The fixed explanation used when the AI is off, slow or invalid, and in sample mode. */
export const templateExplain = (flagText: string, kind: FlagKind): string => `${flagText.replace(/[.\s]+$/, '')}. ${HINTS[kind]}`;

/** No phone-like number, database id, UHID, order number, ER number or case number may come back from the AI. */
const leaks = (s: string) =>
  /\d{9,}/.test(s) || /[a-f\d]{24}/i.test(s) || /\bMO-\d+/.test(s) || /MHK\d+/i.test(s) || /\bER-\d+/.test(s) || /\bCASE-\d+/.test(s);

export function validateExplain(raw: unknown): { text: string } | null {
  const text = typeof (raw as { text?: unknown } | null)?.text === 'string' ? (raw as { text: string }).text.trim() : '';
  return text && text.length <= TEXT_MAX && !leaks(text) ? { text } : null;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};

const INSTRUCTIONS =
  'Explain this medicine safety flag to the pharmacist in one or two plain sentences, using only the facts given: why it matters for this medicine and patient. ' +
  `Stay under ${TEXT_MAX} characters. Do not say whether to approve, confirm, change or stop the medicine, do not give a new dose, and do not diagnose. ` +
  'Do not include names, ids, order numbers or numbers that identify a person.';

interface MedicineSent {
  medicine: string;
  dose: number | null;
  unit: string;
  route: string;
  frequency: string;
}

const ACTIVE = ['to-check', 'query', 'approved', 'issued'];

/** The AI explains one flag, on request only. It never sets, clears or confirms a flag. */
@Injectable()
export class PharmacyAiService {
  private readonly logger = new Logger(PharmacyAiService.name);

  constructor(
    private readonly ai: AiService,
    @InjectModel(PharmacyLine.name) private readonly lines: Model<PharmacyLineDocument>,
    private readonly patientFacts: PharmacyPatientsService,
  ) {}

  /** What leaves the system about a line: its medicine's list name and dose, never the product, note or typed name. */
  private sent(l: { medicine: string | null; dose: number | null; unit: string; route: string; frequency: string; flags?: Flag[] }): MedicineSent {
    const unreadable = (l.flags ?? []).some((f) => f.key === 'list.dose-unreadable');
    return {
      medicine: (l.medicine ? medicineByKey(l.medicine)?.name : null) ?? UNLISTED,
      dose: unreadable ? null : l.dose,
      unit: l.unit,
      // Free text never leaves: only a known route key and a known frequency key are sent (an unlisted line keeps the route as typed).
      route: Object.prototype.hasOwnProperty.call(ROUTE_LABEL, l.route) ? l.route : '',
      frequency: Object.prototype.hasOwnProperty.call(DOSES_PER_DAY, l.frequency) ? l.frequency : '',
    };
  }

  async explain(lineId: string, flagKey: string): Promise<ExplainResult> {
    const line = isValidObjectId(lineId) ? await this.lines.findById(lineId).lean().exec() : null;
    if (!line) throw new NotFoundException('Medicine line not found');
    const flag = (line.flags ?? []).find((f) => f.key === flagKey);
    if (!flag) throw new NotFoundException('Flag not found');

    const flagText = LIST_WORDS[flag.key] ?? flag.text;
    const template = templateExplain(flagText, flag.kind);

    let other: MedicineSent | undefined;
    const partner = /^(clash|double)\.([a-z0-9-]+)$/.exec(flag.key)?.[2];
    if (partner && medicineByKey(partner)) {
      const found = await this.lines
        .findOne({ patient: line.patient, medicine: partner, status: { $in: ACTIVE }, _id: { $ne: line._id } })
        .sort({ _id: 1 })
        .lean()
        .exec();
      other = found ? this.sent(found) : { medicine: medicineByKey(partner)!.name, dose: null, unit: '', route: '', frequency: '' };
    }

    // The eGFR is the number from the patient's latest kidney result, not read back out of the flag's words.
    const facts = await this.patientFacts.facts(String(line.patient));
    // Built from a whitelist, never by spreading the line, the flag or the patient.
    const input: Record<string, unknown> = {
      ...this.sent(line),
      flag: { kind: flag.kind, severity: flag.severity, text: flagText },
      ...(other ? { other } : {}),
      patient: { age: facts.age, sex: facts.sex, weightKg: facts.weightKg, egfr: facts.egfr },
    };

    const task: StructuredTask<{ text: string }> = {
      feature: 'pharmacyExplain',
      instructions: INSTRUCTIONS,
      input,
      schema: SCHEMA,
      validate: validateExplain,
      sample: () => ({ text: template }),
    };
    try {
      const res = await this.ai.runStructured(task);
      if (res.ok) {
        const value = validateExplain(res.value);
        if (value) return { text: value.text, sample: res.sample, source: 'ai' };
      }
    } catch (e) {
      // Only the kind of failure: the message could carry what was sent.
      this.logger.warn(`Pharmacy AI request failed (${e instanceof Error ? e.name : typeof e}); using the rule's words`);
    }
    return { text: template, sample: false, source: 'rules' };
  }
}
