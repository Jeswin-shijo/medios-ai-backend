import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { AiService } from '../ai/ai.service';
import { PatientsService } from '../patients/patients.service';
import { ADMIT_ROLES, Actor, OVERRIDE_ROLES } from './actor';
import { AI_PICK_LIMIT, BedAiOutput, bedAiTask, buildBedAiInput, keywordExtraNeeds, mergePicks } from './bed-ai-task';
import { AdmissionRequestInput, BedInfo, Feature, Need, PatientGender, RoomClass, WardInfo } from './bed-types';
import { BedsService } from './beds.service';
import { RuleOutcome, applyRules } from './rules';
import { RankedBed, rankBeds } from './scoring';
import { BedSuggestion, BedSuggestionDocument, SuggestionAiStatus } from './schemas/bed-suggestion.schema';

export interface SuggestInput {
  patientId: string;
  roomClass: RoomClass;
  needs: Need[];
  department: string;
  doctor: string;
  expectedStayDays: number;
  notes: string;
  /** Set for a transfer: the bed the patient is in now. */
  currentBedId?: string;
}

export interface RankedBedView {
  bedId: string;
  label: string;
  wardName: string;
  floor: number;
  ratePerDay: number;
  features: Feature[];
  reason: string;
  aiReason?: string;
  stepUp: boolean;
}

export interface SuggestionResult {
  suggestionId: string;
  appliedRules: string[];
  blockedBy: string[];
  classNote?: string;
  top: RankedBedView[];
  eligible: RankedBedView[];
  ai: 'pending' | 'off';
  /** True when no ward type meets every ticked need (isolation with a ventilator, say). */
  conflict: boolean;
}

export interface AiRefinement {
  status: Exclude<SuggestionAiStatus, 'pending'>;
  sample: boolean;
  top: RankedBedView[];
  extraNeeds: { need: Need; evidence: string }[];
}

/** The Bed Agent's view of a suggestion: every eligible bed, the AI's picks first. */
export interface AgentRanking {
  suggestionId: string;
  ordered: Array<RankedBed & { aiReason?: string }>;
  /** True when the AI answered; its first pick is then `ordered[0]`. */
  aiAnswered: boolean;
  conflict: boolean;
  appliedRules: string[];
  blockedBy: string[];
  classNote?: string;
  extraNeeds: { need: Need; evidence: string }[];
}

type Inventory = { wards: WardInfo[]; beds: BedInfo[] };

const hasText = (s?: string) => !!s?.trim();

/**
 * Either top suggestion needs no reason: the rules' first bed shows at once and staff may
 * confirm it before the AI answers; the AI's first pick then takes its place on screen.
 */
const isTopPick = (log: BedSuggestionDocument, bedId: string) =>
  bedId === log.ruleRanking[0]?.bedId || bedId === log.finalTopBedId;

/** The stored rule order as plain RankedBed objects (not Mongoose subdocuments). */
const storedRanking = (log: BedSuggestionDocument): RankedBed[] =>
  log.ruleRanking.map((r) => ({ bedId: r.bedId, score: r.score, reasons: [...r.reasons], reason: r.reason, stepUp: r.stepUp }));

/**
 * The fixed rules and scoring over the inventory, with no log and no AI: the beds `suggest`
 * offers, and why none when there are none (a scarce bed kept in reserve, say).
 */
export function rankByRules(
  req: AdmissionRequestInput,
  inventory: Inventory,
  now: Date,
): { outcome: RuleOutcome; ranked: RankedBed[]; blockedBy: string[] } {
  const outcome = applyRules(req, inventory.wards, inventory.beds, now);
  const { ranked, reserveBlocked } = rankBeds(req, outcome, inventory.wards, inventory.beds, now);
  const blockedBy = ranked.length ? outcome.blockedBy : [...outcome.blockedBy, ...reserveBlocked];
  return { outcome, ranked, blockedBy };
}

/** The AI's stored answer, when it gave one. */
const aiOutput = (log: BedSuggestionDocument): BedAiOutput | null => (log.ai.status === 'ok' ? log.ai.output : null);

/** Ranked beds with their ward and bed details, skipping any bed no longer in the inventory. */
function toViews(ranked: Array<RankedBed & { aiReason?: string }>, inventory: Inventory): RankedBedView[] {
  const wardById = new Map(inventory.wards.map((w) => [w.id, w]));
  const bedById = new Map(inventory.beds.map((b) => [b.id, b]));
  return ranked.flatMap((r) => {
    const bed = bedById.get(r.bedId);
    const ward = bed && wardById.get(bed.wardId);
    if (!ward) return [];
    const view: RankedBedView = {
      bedId: r.bedId,
      label: bed.label,
      wardName: ward.name,
      floor: ward.floor,
      ratePerDay: ward.ratePerDay,
      features: [...bed.features],
      reason: r.reason,
      stepUp: r.stepUp,
    };
    if (r.aiReason) view.aiReason = r.aiReason;
    return [view];
  });
}

@Injectable()
export class SuggestionsService {
  constructor(
    @InjectModel(BedSuggestion.name) private readonly suggestions: Model<BedSuggestionDocument>,
    private readonly beds: BedsService,
    private readonly patients: PatientsService,
    private readonly ai: AiService,
  ) {}

  /** Applies the fixed rules and ranks the beds, and logs the suggestion. The AI is asked later, by refine. */
  async suggest(actor: Actor, dto: SuggestInput): Promise<SuggestionResult> {
    const patient = await this.patients.findOne(dto.patientId);
    if (!dto.currentBedId && (await this.beds.activeAdmissionForPatient(String(patient._id)))) {
      throw new ConflictException('This patient is already admitted.');
    }

    const now = new Date();
    const inventory = await this.beds.inventory();
    const req: AdmissionRequestInput = {
      age: patient.age,
      gender: patient.gender as PatientGender,
      roomClass: dto.roomClass,
      needs: dto.needs,
      department: dto.department,
      expectedStayDays: dto.expectedStayDays,
      notes: dto.notes,
      currentBedId: dto.currentBedId,
    };
    const { outcome, ranked, blockedBy } = rankByRules(req, inventory, now);

    const { input, refs } = buildBedAiInput({
      req,
      who: { name: patient.name, uhid: patient.uhid, phone: patient.phone, address: patient.address, email: patient.email },
      ranked,
      ...inventory,
    });
    // With no candidate beds there is nothing to ask the AI to choose between.
    const aiStatus = await this.ai.status();
    const aiOn = aiStatus.provider !== 'none' && aiStatus.features.bedSuggestions && ranked.length > 0;

    const log = await this.suggestions.create({
      createdBy: actor.id,
      createdByName: actor.name,
      patient: patient._id,
      request: {
        roomClass: dto.roomClass,
        needs: dto.needs,
        department: dto.department,
        doctor: dto.doctor,
        expectedStayDays: dto.expectedStayDays,
        notes: dto.notes,
        currentBedId: dto.currentBedId,
      },
      aiInput: input,
      refs,
      eligibleBedIds: ranked.map((r) => r.bedId),
      ruleRanking: ranked,
      appliedRules: outcome.appliedRules,
      blockedBy,
      classNote: outcome.classNote,
      ai: { status: aiOn ? 'pending' : 'off', provider: aiStatus.provider, model: aiStatus.model },
    });

    const eligible = toViews(ranked, inventory);
    const result: SuggestionResult = {
      suggestionId: String(log._id),
      appliedRules: outcome.appliedRules,
      blockedBy,
      top: eligible.slice(0, AI_PICK_LIMIT),
      eligible,
      ai: aiOn ? 'pending' : 'off',
      conflict: outcome.conflict,
    };
    if (outcome.classNote) result.classNote = outcome.classNote;
    return result;
  }

  /** Asks the AI once to reorder and explain the top beds; later calls return the stored answer. */
  async refine(actor: Actor, suggestionId: string): Promise<AiRefinement> {
    const found = await this.load(suggestionId);
    if (found.createdBy !== actor.id && !ADMIT_ROLES.includes(actor.role)) {
      throw new ForbiddenException('You cannot use this bed suggestion.');
    }

    const log = await this.askAi(found);
    const output = aiOutput(log);
    return {
      status: log.ai.status as AiRefinement['status'],
      sample: !!log.ai.sample,
      top: toViews(mergePicks(storedRanking(log), output, log.refs), await this.beds.inventory()),
      extraNeeds: output?.extraNeeds ?? [],
    };
  }

  /**
   * Ranks the beds for the Bed Agent: the rules, then the AI once (within its timeout).
   * Without an answer from the AI (off, timed out, invalid, or not asked), the order is the
   * rules' own and the notes are still read, by the keyword check sample mode uses.
   */
  async rankForAgent(actor: Actor, dto: SuggestInput): Promise<AgentRanking> {
    const result = await this.suggest(actor, dto);
    let log = await this.load(result.suggestionId);
    if (result.ai === 'pending') log = await this.askAi(log);
    const output = aiOutput(log);
    const ranking: AgentRanking = {
      suggestionId: result.suggestionId,
      ordered: mergePicks(storedRanking(log), output, log.refs, Infinity),
      aiAnswered: !!output,
      conflict: result.conflict,
      appliedRules: result.appliedRules,
      blockedBy: result.blockedBy,
      extraNeeds: output ? output.extraNeeds : keywordExtraNeeds(log.aiInput.notes, log.aiInput.possibleExtraNeeds),
    };
    if (result.classNote) ranking.classNote = result.classNote;
    return ranking;
  }

  /** Asks the AI about a pending suggestion and stores its answer (or why there is none). */
  private async askAi(log: BedSuggestionDocument): Promise<BedSuggestionDocument> {
    if (log.ai.status !== 'pending') return log;
    const result = await this.ai.runStructured(bedAiTask(log.aiInput));
    const base = { provider: result.provider, model: result.model, latencyMs: result.latencyMs };
    // `=== true`: without strictNullChecks, a truthiness test does not narrow the failure branch.
    const ai =
      result.ok === true
        ? { status: 'ok', sample: result.sample, output: result.value, ...base }
        : { status: result.failure, ...base, ...(result.detail ? { detail: result.detail } : {}) };
    const finalTopBedId = mergePicks(storedRanking(log), result.ok === true ? result.value : null, log.refs)[0]?.bedId;
    const stored = await this.suggestions
      .findOneAndUpdate({ _id: log._id, 'ai.status': 'pending' }, { $set: { ai, finalTopBedId } }, { new: true })
      .exec();
    // If another refine of this suggestion stored its answer first, use that one.
    return stored ?? (await this.load(String(log._id)));
  }

  /**
   * Checks a bed choice before admit or transfer: a bed outside the rules needs a doctor
   * or admin and a reason; a bed other than the top suggestion needs a reason.
   */
  async authorizeChoice(
    suggestionId: string,
    bedId: string,
    actor: Actor,
    choice: { reason?: string; ruleOverride?: boolean },
  ): Promise<BedSuggestionDocument> {
    const log = await this.load(suggestionId);
    if (!log.eligibleBedIds.includes(bedId)) {
      if (!choice.ruleOverride) throw new BadRequestException('This bed does not meet the rules for this patient.');
      if (!OVERRIDE_ROLES.includes(actor.role)) throw new ForbiddenException('Only a doctor or admin can ignore the bed rules.');
      if (!hasText(choice.reason)) throw new BadRequestException('Give a reason for ignoring the rules.');
    } else if (!isTopPick(log, bedId) && !hasText(choice.reason)) {
      throw new BadRequestException('Give a short reason for not choosing the top suggestion.');
    }
    return log;
  }

  /** The gender of the suggestion's patient, which a held bed records for the twin-room rule. */
  async patientGender(suggestionId: string): Promise<PatientGender> {
    const log = await this.load(suggestionId);
    const patient = await this.patients.findOne(String(log.patient));
    return patient.gender as PatientGender;
  }

  /** Saves the bed finally chosen and the admission it went to. */
  async recordChoice(
    suggestionId: string,
    result: { bedId: string; admissionId: string; reason?: string; ruleOverride?: boolean },
  ): Promise<void> {
    const log = await this.load(suggestionId);
    const reason = result.reason?.trim();
    await this.suggestions
      .updateOne(
        { _id: log._id },
        {
          $set: {
            finalBedId: result.bedId,
            wasTopPick: isTopPick(log, result.bedId),
            ruleOverride: !!result.ruleOverride,
            admission: result.admissionId,
            ...(reason ? { reason } : {}),
          },
        },
      )
      .exec();
  }

  private async load(suggestionId: string): Promise<BedSuggestionDocument> {
    const log = isValidObjectId(suggestionId) ? await this.suggestions.findById(suggestionId).exec() : null;
    if (!log) throw new NotFoundException('This bed suggestion was not found. Start again.');
    return log;
  }
}
