import { ConflictException, ForbiddenException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Types } from 'mongoose';
import { Subscription, debounceTime } from 'rxjs';
import { clinicNow } from '../../common/utils/clinic-time';
import { SettingsService } from '../settings/settings.service';
import { AGENT_ACTOR, Actor, REQUEST_ROLES } from './actor';
import { autoAssignable, nearestOptionText, splitExtraNeeds } from './agent-policy';
import { BedEvents } from './bed-events';
import { BedRequestsService } from './bed-requests.service';
import { AdmissionRequestInput, BedInfo, Need, WardInfo } from './bed-types';
import { BedsService } from './beds.service';
import {
  BedDecision,
  BedRequest,
  BedRequestDocument,
  NeedEvidence,
  RequestState,
  ResolvedNeed,
} from './schemas/bed-request.schema';
import { RankedBed, clipReason } from './scoring';
import { AgentRanking, SuggestInput, SuggestionsService, rankByRules } from './suggestions.service';

type Inventory = { wards: WardInfo[]; beds: BedInfo[] };
type RankedChoice = AgentRanking['ordered'][number];

/** Beds tried in one pass; when all were taken meanwhile, the request waits for the next. */
const BEDS_PER_PASS = 5;
/** Unexpected errors before the agent hands a request to staff. */
const MAX_ATTEMPTS = 3;
/** A burst of bed changes (a transfer is several) wakes the agent once. */
const SETTLE_MS = 500;
/** Ranked beds kept on the decision for staff to compare. */
const DECISION_CANDIDATES = 5;

const SEARCHING = 'Bed Agent is looking for a bed.';
const ALLOCATION_OFF = 'Automatic allocation is off. Assign a bed by hand.';
const NO_BED = 'No free bed meets the rules yet.';
const BEDS_TAKEN = 'The free beds were just taken. Trying again.';
const RETRYING = 'Something went wrong while assigning a bed. Trying again.';
const GAVE_UP = 'Something went wrong while assigning a bed. Assign one by hand.';
const BUSY = 'The Bed Agent is working on this request. Try again in a moment.';
const CLOSED = 'This request is already closed.';
/** States that keep an alert raised. */
const ALERTED: RequestState[] = ['waiting', 'attention'];

/** A need in running text: "Confirm isolation for …", "Added oxygen: …". */
const NEED_LABEL: Record<Need, string> = {
  oxygen: 'oxygen',
  highFallRisk: 'high fall risk',
  isolation: 'isolation',
  ventilator: 'a ventilator',
  monitor: 'a monitor',
  pregnant: 'pregnancy',
};

const quote = (text: string) => `“${text}”`;
const listed = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);
const plain = (needs: NeedEvidence[]): NeedEvidence[] => needs.map(({ need, evidence }) => ({ need, evidence }));
/** Plain copies with a real Date: toState's update is not cast. */
const plainResolved = (needs: Array<Omit<ResolvedNeed, 'at'> & { at: Date | string }>): ResolvedNeed[] =>
  needs.map(({ need, evidence, confirmed, byName, at }) => ({ need, evidence, confirmed, byName, at: new Date(at) }));
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "Notes mention “TB”. Confirm isolation for Suresh P?" */
const confirmText = (pending: NeedEvidence, patientName: string) =>
  `Notes mention ${quote(pending.evidence)}. Confirm ${NEED_LABEL[pending.need]} for ${patientName}?`;

/** "Added oxygen: notes mention “SpO₂”." */
const addedText = (added: NeedEvidence[]) =>
  `Added ${listed(added.map((a) => NEED_LABEL[a.need]))}: notes mention ${listed(added.map((a) => quote(a.evidence)))}.`;

/** The request as the rules see it. A transfer leaves the patient's current bed out. */
function ruleInput(req: BedRequestDocument): AdmissionRequestInput {
  return {
    age: req.patientAge,
    gender: req.patientGender,
    roomClass: req.roomClass,
    needs: [...req.needs],
    department: req.department,
    expectedStayDays: req.expectedStayDays,
    notes: req.notes,
    currentBedId: req.type === 'transfer' && req.fromBed ? String(req.fromBed) : undefined,
  };
}

function suggestInput(req: BedRequestDocument): SuggestInput {
  const { roomClass, needs, department, expectedStayDays, notes, currentBedId } = ruleInput(req);
  return { patientId: String(req.patient), roomClass, needs, department, doctor: req.doctor, expectedStayDays, notes, currentBedId };
}

/** Why a request waits: the nearest class on offer, else what the rules blocked. */
const waitReason = (input: AdmissionRequestInput, ordered: RankedBed[], blockedBy: string[], inventory: Inventory) =>
  nearestOptionText(input, ordered, inventory.wards, inventory.beds) ?? blockedBy[0] ?? NO_BED;

/**
 * Places patients for doctors' bed requests, inside the fixed rules, with nobody approving.
 * One request at a time, in this API: each pass runs after the one before it. A pass
 * claims its request first, so another API instance never works on the same one.
 */
@Injectable()
export class BedAgentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BedAgent');
  private chain: Promise<void> = Promise.resolve();
  /** Requests queued and not yet started, so a burst of wake-ups queues each one once. */
  private readonly queued = new Set<string>();
  private bedChanges?: Subscription;

  constructor(
    private readonly requests: BedRequestsService,
    private readonly suggestions: SuggestionsService,
    private readonly beds: BedsService,
    private readonly settings: SettingsService,
    private readonly events: BedEvents,
  ) {}

  /** A bed that frees (cleaned, unblocked, vacated) may suit a waiting request. */
  onModuleInit() {
    this.bedChanges = this.events.changes$.pipe(debounceTime(SETTLE_MS)).subscribe(() => {
      this.retryWaiting().catch((err) => this.logger.warn(`Retrying waiting requests failed: ${errorText(err)}`));
    });
  }

  onModuleDestroy() {
    this.bedChanges?.unsubscribe();
  }

  /** Queues a pass for the request, after any already queued. */
  submit(id: string): void {
    this.enqueue(id, () => this.process(id));
  }

  /** Queues a check that only closes the request if it no longer makes sense. */
  private submitMootCheck(id: string): void {
    this.enqueue(`moot:${id}`, () => this.closeIfMootOnly(id));
  }

  private enqueue(key: string, run: () => Promise<void>): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.chain = this.chain
      .then(() => {
        this.queued.delete(key);
        return run();
      })
      .catch((err) => this.logger.error(`Bed request ${key}: ${errorText(err)}`));
  }

  /** Resolves once every queued pass has run, including passes queued meanwhile. */
  async idle(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.chain;
      await tail;
    } while (tail !== this.chain);
  }

  /** Queues every waiting request: highest priority first, then oldest. */
  async retryWaiting(): Promise<void> {
    for (const req of await this.requests.waiting()) this.submit(String(req._id));
  }

  /**
   * At start-up and every minute: requests a stopped pass left searching, then everything
   * waiting. Requests that need attention are only checked for being moot (the patient was
   * discharged or admitted by hand): staff decide the rest.
   */
  async recover(): Promise<void> {
    for (const req of await this.requests.unclaimedSearching()) this.submit(String(req._id));
    await this.retryWaiting();
    for (const req of await this.requests.unclaimedAttention()) this.submitMootCheck(String(req._id));
  }

  /** One pass over a request. Never leaves it locked; errors end in waiting or attention. */
  async process(id: string): Promise<void> {
    const req = await this.requests.claim(id);
    if (!req) return;
    try {
      if (req.state !== 'searching' && req.state !== 'waiting') return;
      await this.pass(req);
    } catch (err) {
      await this.failed(req, err).catch((e) => this.logger.error(`Bed request ${id}: ${errorText(e)}`));
    } finally {
      await this.requests.release(id);
    }
  }

  /** Closes a request that needs attention once it no longer makes sense. Never assigns a bed or changes it otherwise. */
  private async closeIfMootOnly(id: string): Promise<void> {
    const req = await this.requests.claim(id);
    if (!req) return;
    try {
      if (req.state === 'attention') await this.closeIfMoot(req);
    } catch (err) {
      this.logger.warn(`Bed request ${id}: checking whether it is still needed failed: ${errorText(err)}`);
    } finally {
      await this.requests.release(id);
    }
  }

  /** A doctor or admin confirms or dismisses a need the notes pointed to. With none left, the agent carries on. */
  async resolveNotesNeed(actor: Actor, id: string, need: Need, confirm: boolean): Promise<void> {
    if (!REQUEST_ROLES.includes(actor.role)) {
      throw new ForbiddenException('Only a doctor or admin can confirm or dismiss a need from the notes.');
    }
    // The claim keeps two decisions (or a decision and an agent pass) from overwriting each other.
    const req = await this.requests.claim(id);
    if (!req) throw new ConflictException((await this.requests.get(id)).open ? BUSY : CLOSED);
    let carryOn = false;
    try {
      const pending = req.pendingNeeds.find((n) => n.need === need);
      if (req.state !== 'attention' || !pending) {
        throw new ConflictException('This need is no longer waiting for a decision.');
      }
      const remaining = req.pendingNeeds.filter((n) => n.need !== need);
      const resolved: ResolvedNeed = { need, evidence: pending.evidence, confirmed: confirm, byName: actor.name, at: clinicNow() };
      const patch: Partial<BedRequest> = {
        pendingNeeds: plain(remaining),
        needs: confirm && !req.needs.includes(need) ? [...req.needs, need] : [...req.needs],
        dismissedNeeds: confirm ? [...req.dismissedNeeds] : [...req.dismissedNeeds, need],
        resolvedNeeds: [...plainResolved(req.resolvedNeeds), resolved],
      };
      const decided = `${actor.name} ${confirm ? 'confirmed' : 'dismissed'} ${NEED_LABEL[need]}. ${SEARCHING}`;
      const updated = remaining.length
        ? await this.to(req, 'attention', confirmText(remaining[0], req.patientName), patch)
        : await this.to(req, 'searching', decided, patch);
      if (!updated) throw new ConflictException(CLOSED);
      carryOn = updated.state === 'searching';
    } finally {
      await this.requests.release(id);
    }
    if (carryOn) this.submit(id);
  }

  /** Staff placed the request's patient by hand: the request closes with their choice. */
  async completeByHand(
    id: string,
    result: {
      bedId: string;
      bedLabel: string;
      wardName: string;
      admissionId: string;
      actor: Actor;
      reason?: string;
      ruleOverride?: boolean;
      suggestionId: string;
    },
  ): Promise<void> {
    const req = await this.requests.get(id);
    if (!req.open) return;
    const decision: BedDecision = {
      suggestionId: result.suggestionId,
      by: 'staff',
      bedId: result.bedId,
      bedLabel: result.bedLabel,
      wardName: result.wardName,
      reason: clipReason(result.reason?.trim() || `Chosen by ${result.actor.name}.`),
      appliedRules: [],
      addedNeeds: plain(req.addedNeeds),
      candidates: [],
      resolvedNeeds: plainResolved(req.resolvedNeeds),
      sample: false,
      ...(result.ruleOverride ? { ruleOverride: true } : {}),
    };
    const patch: Partial<BedRequest> = {
      assignedBed: new Types.ObjectId(result.bedId),
      assignedBedLabel: result.bedLabel,
      assignedAt: clinicNow(),
      admission: new Types.ObjectId(result.admissionId),
      decision,
      closedByName: result.actor.name,
    };
    const reason = clipReason(`Assigned to ${result.bedLabel} by ${result.actor.name}.`);
    await this.requests.toState(id, 'assigned', reason, patch, { onlyIfOpen: true });
  }

  /** One pass over a claimed request that is searching or waiting. */
  private async pass(req: BedRequestDocument): Promise<void> {
    if (await this.closeIfMoot(req)) return;
    if (!(await this.autoAllocateOn())) {
      await this.to(req, 'attention', ALLOCATION_OFF);
      return;
    }
    // A retry looks with the rules alone first: no suggestion log or AI call while no bed is in sight.
    if (req.state === 'waiting' && !(await this.bedInSight(req))) return;
    await this.allocate(req);
  }

  /**
   * Closes a request that no longer makes sense: the patient to transfer has left the bed
   * (discharged, or moved by hand), or the patient to admit was admitted by hand.
   */
  private async closeIfMoot(req: BedRequestDocument): Promise<boolean> {
    const active = await this.beds.activeAdmissionForPatient(String(req.patient));
    let reason: string;
    if (req.type === 'transfer') {
      if (active && String(active.bed) === String(req.fromBed)) return false;
      reason = `Closed: the patient is no longer in ${req.fromBedLabel ?? 'the bed'}.`;
    } else {
      if (!active) return false;
      const { beds } = await this.beds.inventory();
      const label = beds.find((b) => b.id === String(active.bed))?.label ?? 'a bed';
      reason = `Closed: the patient was admitted to ${label} by hand.`;
    }
    await this.to(req, 'cancelled', reason, { closedByName: AGENT_ACTOR.name });
    return true;
  }

  /**
   * A retry's first look, with the rules alone on the request's own fields: is there a bed
   * the agent could take? If not, the request keeps waiting.
   */
  private async bedInSight(req: BedRequestDocument): Promise<boolean> {
    const inventory = await this.beds.inventory();
    const input = ruleInput(req);
    const { outcome, ranked, blockedBy } = rankByRules(input, inventory, new Date());
    if (outcome.conflict || autoAssignable(input, ranked, inventory.wards, inventory.beds).length) return true;
    await this.to(req, 'waiting', waitReason(input, ranked, blockedBy, inventory));
    return false;
  }

  /** Rank, settle needs from the notes, then take the best bed the agent may assign on its own. */
  private async allocate(claimed: BedRequestDocument): Promise<void> {
    let req = claimed;
    let rank = await this.rank(req);
    const { auto, confirm } = splitExtraNeeds(rank.extraNeeds, req.needs, req.dismissedNeeds);
    if (confirm.length) {
      await this.to(req, 'attention', confirmText(confirm[0], req.patientName), { pendingNeeds: confirm });
      return;
    }
    if (auto.length) {
      req = await this.addNeeds(req, auto);
      if (!req) return;
      // Once more with the needs added; needs this second answer finds are left alone.
      rank = await this.rank(req);
    }
    if (rank.conflict) {
      await this.to(req, 'attention', rank.blockedBy[0]);
      return;
    }

    const inventory = await this.beds.inventory();
    const input = ruleInput(req);
    const options = autoAssignable(input, rank.ordered, inventory.wards, inventory.beds);
    if (!options.length) {
      await this.to(req, 'waiting', waitReason(input, rank.ordered, rank.blockedBy, inventory));
      return;
    }
    for (const choice of options.slice(0, BEDS_PER_PASS)) {
      const admissionId = await this.take(req, choice.bedId, rank.suggestionId);
      if (!admissionId) continue;
      await this.recordAssigned(req, rank, choice, admissionId, inventory);
      return;
    }
    await this.to(req, 'waiting', BEDS_TAKEN);
  }

  private rank(req: BedRequestDocument): Promise<AgentRanking> {
    return this.suggestions.rankForAgent(AGENT_ACTOR, suggestInput(req));
  }

  /** Adds needs the notes showed that never change the ward, and keeps them on the request. */
  private addNeeds(req: BedRequestDocument, auto: NeedEvidence[]): Promise<BedRequestDocument | null> {
    return this.to(req, 'searching', addedText(auto), {
      needs: [...req.needs, ...auto.map((a) => a.need)],
      addedNeeds: [...plain(req.addedNeeds), ...plain(auto)],
    });
  }

  /** Puts the patient in the bed. Null when the bed was taken (or its twin room changed) meanwhile. */
  private async take(req: BedRequestDocument, bedId: string, suggestionId: string): Promise<string | null> {
    try {
      const admission =
        req.type === 'transfer'
          ? await this.beds.transferToFreeBed(
              String(req.fromBed),
              bedId,
              AGENT_ACTOR,
              `${req.stepDown ? 'Step-down' : 'Transfer'} requested by ${req.requestedByName}`,
              req.patientGender,
            )
          : await this.beds.admitToFreeBed(bedId, AGENT_ACTOR, {
              patientId: String(req.patient),
              suggestionId,
              doctor: req.doctor,
              department: req.department,
              roomClass: req.roomClass,
              needs: [...req.needs],
              notes: req.notes,
              expectedStayDays: req.expectedStayDays,
            });
      return String(admission._id);
    } catch (err) {
      if (err instanceof ConflictException) return null;
      throw err;
    }
  }

  /** Closes the request on its bed, with why the agent chose it. */
  private async recordAssigned(
    req: BedRequestDocument,
    rank: AgentRanking,
    choice: RankedChoice,
    admissionId: string,
    inventory: Inventory,
  ): Promise<void> {
    const bedById = new Map(inventory.beds.map((b) => [b.id, b]));
    const bed = bedById.get(choice.bedId);
    const ward = inventory.wards.find((w) => w.id === bed.wardId);
    // Any bed the AI picked (its first, or a later one when the first was taken) is the AI's
    // choice, with its reason. Otherwise the rules chose it, and staff see the rules' reason.
    const byAi = rank.aiAnswered && !!choice.aiReason;
    const by = byAi ? 'ai' : 'rules';
    const decision: BedDecision = {
      suggestionId: rank.suggestionId,
      by,
      bedId: choice.bedId,
      bedLabel: bed.label,
      wardName: ward?.name ?? '',
      reason: byAi ? choice.aiReason : choice.reason,
      appliedRules: [...rank.appliedRules],
      addedNeeds: plain(req.addedNeeds),
      candidates: rank.ordered.slice(0, DECISION_CANDIDATES).map((r) => ({
        bedId: r.bedId,
        label: bedById.get(r.bedId)?.label ?? '',
        score: r.score,
        reason: r.aiReason ?? r.reason,
      })),
      resolvedNeeds: plainResolved(req.resolvedNeeds),
      sample: byAi && rank.aiSample,
    };
    await this.to(req, 'assigned', `Assigned to ${bed.label}.`, {
      assignedBed: new Types.ObjectId(choice.bedId),
      assignedBedLabel: bed.label,
      assignedAt: clinicNow(),
      admission: new Types.ObjectId(admissionId),
      decision,
    });
  }

  /**
   * A pass that threw. A conflict outside the bed loop (the patient was admitted by hand
   * meanwhile, say) needs staff. Any other error counts as an attempt: the request waits
   * for a retry, and the third goes to staff.
   */
  private async failed(req: BedRequestDocument, err: unknown): Promise<void> {
    if (err instanceof ConflictException) {
      await this.to(req, 'attention', err.message);
      return;
    }
    this.logger.warn(`Bed request ${req._id} failed: ${errorText(err)}`);
    const attempts = req.attempts + 1;
    const gaveUp = attempts >= MAX_ATTEMPTS;
    await this.to(req, gaveUp ? 'attention' : 'waiting', gaveUp ? GAVE_UP : RETRYING, { attempts });
  }

  private async autoAllocateOn(): Promise<boolean> {
    const settings = await this.settings.getSettings();
    return settings.ai?.bedAutoAllocate !== false;
  }

  /**
   * Every state change the agent makes, with its reason cut to 140 characters. A request
   * closed meanwhile (cancelled, say) is left alone: null. When nothing would change (a
   * retry still waiting for the same reason, its alert raised), nothing is written, raised
   * or emitted. `req` is the request as this pass last wrote or claimed it.
   */
  private async to(
    req: BedRequestDocument,
    state: RequestState,
    reason: string,
    patch: Partial<BedRequest> = {},
  ): Promise<BedRequestDocument | null> {
    const text = clipReason(reason);
    const unchanged =
      req.state === state && req.stateReason === text && !Object.keys(patch).length && (!!req.alert || !ALERTED.includes(state));
    if (unchanged) return req;
    return this.requests.toState(String(req._id), state, text, patch, { onlyIfOpen: true });
  }
}
