import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { clinicNow } from '../../common/utils/clinic-time';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { MessagesService } from '../coordinator/messages.service';
import { RulesService } from '../coordinator/rules.service';
import { VitalsService } from '../vitals/vitals.service';
import {
  BED_PRIORITY,
  COLOUR_RANK,
  COMPLAINTS,
  ComplaintKey,
  PATHWAYS,
  PathwayKey,
  StepKey,
  TriageColour,
  TriageVitals,
  doctorDueMinutes,
  pathwaysFor,
  suggestTriage,
} from './er-rules';
import { ErTargetsService } from './er-targets.service';
import { ErVisitView, ErVisitsService } from './er-visits.service';
import { ErVisit, ErVisitDocument } from './schemas/er-visit.schema';

const MIN_MS = 60_000;
const COLOURS = Object.keys(COLOUR_RANK) as TriageColour[];

export interface SuggestInput {
  complaint: ComplaintKey;
  vitals: TriageVitals;
  painScore?: number;
}

/** The diastolic reading is only needed to save a Vitals record; the colour rules never use it. */
export interface TriageInput extends SuggestInput {
  vitals: TriageVitals & { bpDiastolic?: number };
  colour: TriageColour;
  reason?: string;
}

/** A pathway is running while its latest entry is not cancelled. */
const runningKeys = (visit: any): PathwayKey[] => {
  const latest = new Map<string, any>();
  for (const p of visit.pathways ?? []) latest.set(p.key, p);
  return [...latest.values()].filter((p) => !p.cancelled).map((p) => p.key as PathwayKey);
};

const stepLabel = (step: StepKey): string => {
  for (const p of Object.values(PATHWAYS)) {
    const s = p.steps.find((x) => x.key === step);
    if (s) return s.label;
  }
  return step;
};

/** ER triage, fast-track pathways, their steps and the doctor-seen mark. Every change tells the Coordinator. */
@Injectable()
export class ErTriageService {
  constructor(
    @InjectModel(ErVisit.name) private readonly visits: Model<ErVisitDocument>,
    private readonly vitals: VitalsService,
    private readonly rules: RulesService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    private readonly erTargets: ErTargetsService,
    private readonly views: ErVisitsService,
  ) {}

  /** The suggestion only: nothing is saved. */
  suggest(input: SuggestInput): { colour: TriageColour; reasons: string[]; pathways: PathwayKey[] } {
    const { colour, reasons } = suggestTriage(input);
    return { colour, reasons, pathways: pathwaysFor(input.complaint, input.vitals) };
  }

  private async targets(): Promise<Record<string, number>> {
    return this.erTargets.getTargets();
  }

  private async load(id: string): Promise<ErVisitDocument> {
    const visit = isValidObjectId(id) ? await this.visits.findById(id).exec() : null;
    if (!visit) throw new NotFoundException('ER visit not found');
    if (visit.status === 'left') throw new ConflictException('This patient has left the ER.');
    return visit;
  }

  private async loadTriaged(id: string): Promise<ErVisitDocument> {
    const visit = await this.load(id);
    if (!visit.triage || visit.status === 'waiting-triage') throw new ConflictException('Triage this patient first.');
    return visit;
  }

  /** From the visit's real arrival time, never the clinic clock. */
  private doctorDueAt(visit: any, colour: TriageColour, running: PathwayKey[], targets: Record<string, number>): Date {
    return new Date(new Date(visit.createdAt).getTime() + doctorDueMinutes(colour, running, targets) * MIN_MS);
  }

  /** Steps not yet done, never `doctor`, each due at arrival plus its target. */
  private stepDue(visit: any, pathway: PathwayKey, targets: Record<string, number>): Record<string, Date> {
    const out: Record<string, Date> = {};
    for (const s of PATHWAYS[pathway].steps) {
      if (s.key === 'doctor') continue;
      if ((visit.steps ?? []).some((x: any) => x.key === s.key && x.doneAt)) continue;
      const minutes = targets[`${pathway}.${s.key}`] ?? s.defaultMin;
      out[s.key] = new Date(new Date(visit.createdAt).getTime() + minutes * MIN_MS);
    }
    return out;
  }

  private colourOf(visit: any): TriageColour {
    return visit.triage.colour as TriageColour;
  }

  async triage(actor: Actor, visitId: string, input: TriageInput): Promise<ErVisitView> {
    const visit = await this.load(visitId);
    if (visit.status !== 'waiting-triage') throw new ConflictException('This patient is already triaged. Use re-triage.');
    if (!COLOURS.includes(input.colour)) throw new BadRequestException('"colour" must be red, orange, yellow or green');
    if (!COMPLAINTS.some((c) => c.key === input.complaint)) throw new BadRequestException('Pick what the patient came in with');
    const vitals = input.vitals ?? {};

    // The suggestion is always worked out here; a client-sent one is never trusted.
    const suggestion = suggestTriage({ complaint: input.complaint, vitals, painScore: input.painScore });
    const reason = (input.reason ?? '').trim();
    if (COLOUR_RANK[input.colour] > COLOUR_RANK[suggestion.colour] && !reason) {
      throw new BadRequestException('Give a reason for a lower colour than suggested.');
    }

    // A Vitals record needs blood pressure and heart rate; without them none is saved.
    let vitalsId: string | undefined;
    if (vitals.bpSystolic !== undefined && vitals.bpDiastolic !== undefined && vitals.heartRate !== undefined) {
      const record = await this.vitals.create({
        uhid: visit.patientUhid,
        recordedBy: actor.name,
        bpSystolic: vitals.bpSystolic,
        bpDiastolic: vitals.bpDiastolic,
        heartRate: vitals.heartRate,
        ...(vitals.temperature !== undefined ? { temperature: vitals.temperature } : {}),
        ...(vitals.spo2 !== undefined ? { spo2: vitals.spo2 } : {}),
        ...(vitals.respiratoryRate !== undefined ? { respiratoryRate: vitals.respiratoryRate } : {}),
      });
      vitalsId = String(record._id);
    }

    // The readings stay on the visit even when no Vitals record could be saved.
    const savedVitals = Object.fromEntries(
      (['spo2', 'bpSystolic', 'bpDiastolic', 'heartRate', 'respiratoryRate', 'temperature'] as const)
        .filter((k) => typeof vitals[k] === 'number' && Number.isFinite(vitals[k]))
        .map((k) => [k, vitals[k]]),
    );

    const at = clinicNow();
    const updated = await this.visits
      .findOneAndUpdate(
        { _id: visit._id, status: 'waiting-triage' },
        {
          $set: {
            complaint: input.complaint,
            status: 'waiting-doctor',
            triage: {
              suggested: suggestion.colour,
              reasons: suggestion.reasons,
              colour: input.colour,
              byName: actor.name,
              at,
              ...(reason ? { changeReason: reason } : {}),
              history: [{ colour: input.colour, byName: actor.name, at, kind: 'triage', ...(reason ? { reason } : {}) }],
            },
            ...(vitalsId ? { vitalsId } : {}),
            ...(Object.keys(savedVitals).length ? { vitals: savedVitals } : {}),
            ...(typeof input.painScore === 'number' ? { painScore: input.painScore } : {}),
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new ConflictException('This patient is already triaged. Use re-triage.');

    const { case: theCase } = await this.cases.openOrJoin({
      patientId: String(updated.patient),
      patientUhid: updated.patientUhid,
      patientName: updated.patientName,
      kind: 'er',
      priority: BED_PRIORITY[input.colour],
      openedBy: 'er',
    });
    const caseId = String(theCase._id);

    const targets = await this.targets();
    const toStart = (await this.rules.isOn('er-auto-pathways')) ? pathwaysFor(input.complaint, vitals) : [];
    // The clock already counts the pathways that are about to start.
    const doctorDueAt = this.doctorDueAt(updated, input.colour, toStart, targets);
    await this.messages.send({
      case: caseId,
      from: 'er',
      to: ['coordinator'],
      type: 'er.triaged',
      priority: BED_PRIORITY[input.colour],
      summary: `${updated.number} triaged ${input.colour}: ${this.complaintLabel(input.complaint)}`,
      payload: { visitId: String(updated._id), colour: input.colour, doctorDueAt },
    });

    let current: ErVisitDocument = updated;
    for (const key of toStart) {
      const next = await this.beginPathway(current, key, 'rules', caseId, targets, doctorDueAt);
      if (next) current = next;
    }
    return (await this.views.toViews([current]))[0];
  }

  private complaintLabel(key: string): string {
    return COMPLAINTS.find((c) => c.key === key)?.label ?? key;
  }

  async retriage(actor: Actor, visitId: string, colour: TriageColour, reason: string): Promise<ErVisitView> {
    const visit = await this.loadTriaged(visitId);
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Give a reason for changing the colour.');
    if (!COLOURS.includes(colour)) throw new BadRequestException('"colour" must be red, orange, yellow or green');
    const old = this.colourOf(visit);
    if (colour === old) throw new BadRequestException('That is already the colour.');

    const updated = await this.visits
      .findOneAndUpdate(
        { _id: visit._id, 'triage.colour': old, status: { $ne: 'left' } },
        {
          $set: { 'triage.colour': colour },
          $push: { 'triage.history': { colour, byName: actor.name, at: clinicNow(), reason: why, kind: 'retriage' } },
        },
        { new: true },
      )
      .exec();
    if (!updated) throw new ConflictException('The colour changed while you were editing. Check the patient and try again.');

    const { case: theCase } = await this.cases.openOrJoin({
      patientId: String(updated.patient),
      patientUhid: updated.patientUhid,
      patientName: updated.patientName,
      kind: 'er',
      priority: BED_PRIORITY[colour],
      openedBy: 'er',
    });
    const doctorDueAt = this.doctorDueAt(updated, colour, runningKeys(updated), await this.targets());
    await this.messages.send({
      case: String(theCase._id),
      from: 'er',
      to: ['coordinator'],
      type: 'er.retriaged',
      priority: BED_PRIORITY[colour],
      summary: `${updated.number} re-triaged ${old} to ${colour}: ${this.complaintLabel(updated.complaint)}`,
      payload: { visitId: String(updated._id), colour, doctorDueAt },
      // The same change twice in a minute (red, orange, red) is a new action, not a repeat.
      dedupeKey: `er.retriaged:${String(updated._id)}:${updated.triage!.history.length}`,
    });
    return (await this.views.toViews([updated]))[0];
  }

  async startPathway(actor: Actor, visitId: string, key: PathwayKey): Promise<ErVisitView> {
    const visit = await this.loadTriaged(visitId);
    if (!PATHWAYS[key]) throw new BadRequestException('Unknown pathway');
    if (runningKeys(visit).includes(key)) throw new ConflictException(`The ${PATHWAYS[key].label} pathway is already running.`);
    const updated = await this.beginPathway(visit, key, 'staff', String(visit.case), await this.targets(), undefined, actor.name);
    if (!updated) throw new ConflictException(`The ${PATHWAYS[key].label} pathway is already running.`);
    return (await this.views.toViews([updated]))[0];
  }

  /**
   * Adds the pathway and its missing step entries, then tells the Coordinator. Null when it was already running.
   * `doctorDueAt` is given when several pathways start together, so all their messages agree.
   */
  private async beginPathway(
    visit: ErVisitDocument,
    key: PathwayKey,
    startedBy: 'rules' | 'staff',
    caseId: string,
    targets: Record<string, number>,
    doctorDueAt?: Date,
    byName?: string,
  ): Promise<ErVisitDocument | null> {
    const have = new Set((visit.steps ?? []).map((s) => s.key));
    const newSteps = PATHWAYS[key].steps.filter((s) => !have.has(s.key)).map((s) => ({ key: s.key }));
    const updated = await this.visits
      .findOneAndUpdate(
        // Two starts at once: only one finds no running entry.
        { _id: visit._id, status: { $ne: 'left' }, pathways: { $not: { $elemMatch: { key, cancelled: { $exists: false } } } } },
        { $push: { pathways: { key, startedBy, ...(startedBy === 'staff' && byName ? { startedByName: byName } : {}) }, ...(newSteps.length ? { steps: { $each: newSteps } } : {}) } },
        { new: true },
      )
      .exec();
    if (!updated) return null;
    const label = PATHWAYS[key].label;
    await this.messages.send({
      case: caseId,
      from: 'er',
      to: ['coordinator'],
      type: 'er.pathway-started',
      priority: BED_PRIORITY[this.colourOf(updated)],
      summary: `${updated.number} ${this.colourOf(updated)}: ${label} pathway started`,
      payload: {
        visitId: String(updated._id),
        pathway: key,
        stepDue: this.stepDue(updated, key, targets),
        doctorDueAt: doctorDueAt ?? this.doctorDueAt(updated, this.colourOf(updated), runningKeys(updated), targets),
      },
      // Start, cancel, restart sends the same payload again: the entry's place makes each start its own.
      dedupeKey: `er.pathway-started:${String(updated._id)}:${updated.pathways.length - 1}`,
    });
    return updated;
  }

  async cancelPathway(actor: Actor, visitId: string, key: PathwayKey, reason: string): Promise<ErVisitView> {
    const visit = await this.loadTriaged(visitId);
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Give a reason for cancelling the pathway.');
    if (!PATHWAYS[key]) throw new BadRequestException('Unknown pathway');
    const updated = await this.visits
      .findOneAndUpdate(
        { _id: visit._id, pathways: { $elemMatch: { key, cancelled: { $exists: false } } } },
        { $set: { 'pathways.$[p].cancelled': { byName: actor.name, reason: why, at: clinicNow() } } },
        { new: true, arrayFilters: [{ 'p.key': key, 'p.cancelled': { $exists: false } }] },
      )
      .exec();
    if (!updated) throw new ConflictException(`The ${PATHWAYS[key].label} pathway is not running.`);
    const colour = this.colourOf(updated);
    await this.messages.send({
      case: String(updated.case),
      from: 'er',
      to: ['coordinator'],
      type: 'er.pathway-cancelled',
      priority: BED_PRIORITY[colour],
      summary: `${updated.number} ${colour}: ${PATHWAYS[key].label} pathway cancelled`,
      payload: { visitId: String(updated._id), pathway: key, doctorDueAt: this.doctorDueAt(updated, colour, runningKeys(updated), await this.targets()) },
      dedupeKey: `er.pathway-cancelled:${String(updated._id)}:${updated.pathways.map((p) => p.key).lastIndexOf(key)}`,
    });
    return (await this.views.toViews([updated]))[0];
  }

  async tickStep(actor: Actor, visitId: string, step: StepKey): Promise<ErVisitView> {
    const visit = await this.loadTriaged(visitId);
    if (step === 'doctor') throw new BadRequestException('Use Seen by doctor.');
    const inRunning = runningKeys(visit).some((p) => PATHWAYS[p].steps.some((s) => s.key === step));
    if (!inRunning) throw new ConflictException('That step is not in a running pathway.');
    const entry = (visit.steps ?? []).find((s) => s.key === step);
    if (entry?.doneAt) return (await this.views.toViews([visit]))[0];

    const updated = await this.visits
      .findOneAndUpdate(
        { _id: visit._id, steps: { $elemMatch: { key: step, doneAt: { $exists: false } } } },
        { $set: { 'steps.$[s].doneAt': clinicNow(), 'steps.$[s].byName': actor.name } },
        { new: true, arrayFilters: [{ 's.key': step, 's.doneAt': { $exists: false } }] },
      )
      .exec();
    // Someone ticked it a moment ago: nothing more to say.
    if (!updated) return (await this.views.toViews([(await this.visits.findById(visit._id).exec()) ?? visit]))[0];
    await this.messages.send({
      case: String(updated.case),
      from: 'er',
      to: ['coordinator'],
      type: 'er.step-done',
      priority: BED_PRIORITY[this.colourOf(updated)],
      summary: `${updated.number} ${this.colourOf(updated)}: ${stepLabel(step)}`,
      payload: { visitId: String(updated._id), step },
    });
    return (await this.views.toViews([updated]))[0];
  }

  async doctorSeen(actor: Actor, visitId: string): Promise<ErVisitView> {
    const visit = await this.loadTriaged(visitId);
    if (visit.doctorSeenAt) return (await this.views.toViews([visit]))[0];
    const now = clinicNow();
    const updated = await this.visits
      .findOneAndUpdate(
        { _id: visit._id, doctorSeenAt: { $exists: false } },
        {
          $set: {
            doctorSeenAt: now,
            // A patient already waiting for a bed stays waiting for it.
            ...(visit.status === 'waiting-doctor' ? { status: 'in-treatment' } : {}),
            'steps.$[d].doneAt': now,
            'steps.$[d].byName': actor.name,
          },
        },
        { new: true, arrayFilters: [{ 'd.key': 'doctor', 'd.doneAt': { $exists: false } }] },
      )
      .exec();
    if (!updated) return (await this.views.toViews([(await this.visits.findById(visit._id).exec()) ?? visit]))[0];
    await this.messages.send({
      case: String(updated.case),
      from: 'er',
      to: ['coordinator'],
      type: 'er.doctor-seen',
      priority: BED_PRIORITY[this.colourOf(updated)],
      summary: `${updated.number} ${this.colourOf(updated)}: seen by a doctor`,
      payload: { visitId: String(updated._id) },
    });
    return (await this.views.toViews([updated]))[0];
  }
}
