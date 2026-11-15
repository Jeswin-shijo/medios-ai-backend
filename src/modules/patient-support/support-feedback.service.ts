import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { SupportFeedback, SupportFeedbackDocument } from './schemas/support-feedback.schema';
import { SUPPORT_ACTOR } from './support-catalogue';
import { SupportRegistration } from './support-coordinator.registration';
import { SUP_READ } from './support-roles';
import { SupportTicketsService } from './support-tickets.service';

const DAY = 24 * 60 * 60_000;
export const FEEDBACK_ASPECTS = ['communication', 'staff', 'waiting', 'facilities'] as const;
export type FeedbackAspect = (typeof FEEDBACK_ASPECTS)[number];
const ASPECT_LABEL: Record<FeedbackAspect, string> = { communication: 'Communication', staff: 'Staff', waiting: 'Waiting time', facilities: 'Facilities' };
const RATING = 'Give a rating from 1 to 5.';

export interface RecordFeedbackInput {
  patientId?: string;
  checkupId?: string;
  source: 'call' | 'desk';
  overall: number;
  aspects?: Partial<Record<FeedbackAspect, number>>;
  comment?: string;
  complaint?: boolean;
}

export interface SupportFeedbackView {
  id: string;
  patient: string | null;
  patientUhid: string;
  patientName: string;
  case: string | null;
  checkup: string | null;
  source: string;
  overall: number;
  band: 'Good' | 'Neutral' | 'Poor';
  aspects: Record<string, number>;
  comment: string;
  complaint: boolean;
  ticketId: string | null;
  byName: string;
  at: Date;
}

export interface FeedbackSummary {
  average: number | null;
  count: number;
  aspects: { key: string; label: string; average: number | null; count: number }[];
}

const band = (n: number): 'Good' | 'Neutral' | 'Poor' => (n >= 4 ? 'Good' : n === 3 ? 'Neutral' : 'Poor');
const score = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) throw new BadRequestException(RATING);
  return v;
};
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Ratings from check-up calls and the desk. A low rating, or the complaint tick, opens a complaint ticket. */
@Injectable()
export class SupportFeedbackService {
  private readonly logger = new Logger(SupportFeedbackService.name);

  constructor(
    private readonly registration: SupportRegistration,
    private readonly tickets: SupportTicketsService,
    private readonly casesService: CasesService,
    @InjectModel(SupportFeedback.name) private readonly feedback: Model<SupportFeedbackDocument>,
    @InjectModel(Patient.name) private readonly patients: Model<PatientDocument>
  ) {}

  private view(f: any): SupportFeedbackView {
    return {
      id: String(f._id),
      patient: f.patient ? String(f.patient) : null,
      patientUhid: f.patientUhid ?? '',
      patientName: f.patientName ?? '',
      case: f.case ? String(f.case) : null,
      checkup: f.checkup ? String(f.checkup) : null,
      source: f.source,
      overall: f.overall,
      band: band(f.overall),
      aspects: f.aspects ?? {},
      comment: f.comment ?? '',
      complaint: !!f.complaint,
      ticketId: f.ticket ? String(f.ticket) : null,
      byName: f.byName ?? '',
      at: f.at
    };
  }

  /** `at` is for the seed only; real feedback is stamped with the real time. */
  async record(actor: Actor, input: RecordFeedbackInput, at?: Date): Promise<SupportFeedbackView> {
    if (!actor || (actor !== SUPPORT_ACTOR && !SUP_READ.includes(actor.role))) {
      throw new ForbiddenException('Only a doctor, a nurse, the front desk or an admin can do this.');
    }
    const source = input.source;
    if (source !== 'call' && source !== 'desk') throw new BadRequestException('The feedback comes from a call or the desk.');
    const overall = score(input.overall);
    const aspects: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.aspects ?? {})) {
      if (v === undefined || v === null) continue;
      if (!(FEEDBACK_ASPECTS as readonly string[]).includes(k)) throw new BadRequestException('Unknown aspect.');
      if (source === 'call') throw new BadRequestException('Aspect scores are only taken at the desk.');
      aspects[k] = score(v);
    }
    const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
    if (comment.length > 500) throw new BadRequestException('Keep the comment under 500 characters.');
    const complaint = overall <= 2 || input.complaint === true;

    let patient: PatientDocument | null = null;
    if (input.patientId) {
      patient = isValidObjectId(input.patientId) ? await this.patients.findById(input.patientId).exec() : null;
      if (!patient) throw new NotFoundException('Patient not found.');
    }
    let caseId: Types.ObjectId | undefined;
    if (patient) {
      const c = await this.casesService.forPatient(String(patient._id));
      if (c && c.state === 'open') caseId = c._id as Types.ObjectId;
    }

    const doc = await this.feedback.create({
      patient: patient?._id,
      patientUhid: patient?.uhid,
      patientName: patient?.name,
      case: caseId,
      checkup: input.checkupId && isValidObjectId(input.checkupId) ? new Types.ObjectId(input.checkupId) : undefined,
      source,
      overall,
      aspects,
      comment: comment || undefined,
      complaint,
      byName: actor.name,
      at: at ?? new Date()
    });

    if (complaint) {
      try {
        const ticket = await this.tickets.open(actor, {
          patientId: patient ? String(patient._id) : undefined,
          callerName: patient?.name || (source === 'call' ? 'Check-up call' : 'Desk feedback'),
          callerPhone: patient?.phone ? String(patient.phone).slice(0, 20) : undefined,
          ticketType: 'complaint',
          question: comment || `Rated ${overall} of 5`,
          source: 'feedback',
          feedbackId: String(doc._id)
        });
        doc.ticket = new Types.ObjectId(ticket.id);
        await doc.save();
        await this.registration.send(
          'support.complaint',
          caseId ? String(caseId) : null,
          { feedbackId: String(doc._id), ticketId: ticket.id, number: ticket.number },
          `${ticket.number}: complaint from feedback (rated ${overall})`,
          patient?.name
        );
      } catch (e) {
        this.logger.warn(`complaint ticket for feedback ${String(doc._id)} not opened: ${(e as Error).message}`);
      }
    }
    return this.view(doc.toObject());
  }

  async list(q: { days?: number; complaintsOnly?: boolean; limit?: number }): Promise<SupportFeedbackView[]> {
    const filter: Record<string, unknown> = {};
    if (q.complaintsOnly) filter.complaint = true;
    if (q.days && q.days > 0) filter.at = { $gte: new Date(Date.now() - q.days * DAY) };
    const limit = Math.min(Math.max(Math.floor(q.limit ?? 50) || 50, 1), 200);
    const rows = await this.feedback.find(filter).sort({ at: -1, _id: -1 }).limit(limit).lean().exec();
    return rows.map((r) => this.view(r));
  }

  async summary(days = 7, now: Date = new Date()): Promise<FeedbackSummary> {
    const rows = await this.feedback
      .find({ at: { $gte: new Date(now.getTime() - days * DAY), $lte: now } })
      .lean()
      .exec();
    const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    return {
      average: avg(rows.map((r) => r.overall)),
      count: rows.length,
      aspects: FEEDBACK_ASPECTS.map((key) => {
        const xs = rows.map((r) => (r.aspects ?? {})[key]).filter((v): v is number => typeof v === 'number');
        return { key, label: ASPECT_LABEL[key], average: avg(xs), count: xs.length };
      })
    };
  }
}
