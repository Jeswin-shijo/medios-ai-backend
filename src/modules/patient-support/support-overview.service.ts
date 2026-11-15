import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { hourOf, trendPct } from '../../common/utils/series';
import type { Actor } from '../beds/actor';
import type { StatCardData } from '../beds/bed-overview';
import { UserRole } from '../users/schemas/user.schema';
import { CheckupCall, CheckupCallDocument } from './schemas/checkup-call.schema';
import { PatientUpdate, PatientUpdateDocument } from './schemas/patient-update.schema';
import { SupportFaq, SupportFaqDocument } from './schemas/support-faq.schema';
import { SupportFeedback, SupportFeedbackDocument } from './schemas/support-feedback.schema';
import { SupportTemplate, SupportTemplateDocument } from './schemas/support-template.schema';
import { SupportTicket, SupportTicketDocument } from './schemas/support-ticket.schema';
import { SupportAiService, SupportDayCounts, SupportTextResult } from './support-ai';
import { TICKET_TYPES, TicketType } from './support-catalogue';
import { FEEDBACK_ASPECTS, SupportFeedbackService, SupportFeedbackView } from './support-feedback.service';
import { SupportTicketRow, SupportTicketsService } from './support-tickets.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ROW_LIMIT = 12;
const SPARK_HOURS = 24;

/** A card; `value` is null when there is no data (first response, satisfaction). */
export type SupportCard = Omit<StatCardData, 'value'> & { value: number | null };
export type SupportCardKey = 'open' | 'updatesToday' | 'firstResponse' | 'satisfaction' | 'escalated' | 'resolvedToday';

export interface SupportInsight {
  key: string;
  tone: 'red' | 'amber' | 'blue' | 'violet';
  title: string;
  sub: string;
  action: { label: string; tab: string; filter?: string };
}

export interface SupportOverview {
  kpis: { openTickets: number; avgFirstResponseMin: number | null; satisfaction7d: number | null; escalated: number };
  cards: Record<SupportCardKey, SupportCard>;
  queue: SupportTicketRow[];
  today: SupportTicketRow[];
  todayCounts: { all: number; open: number; inProgress: number; waiting: number; resolved: number; escalated: number };
  byType: { type: TicketType; count: number }[];
  satisfaction: {
    average: number | null;
    today: number | null;
    count: number;
    todayCount: number;
    aspects: { key: string; label: string; average: number | null; count: number }[];
  };
  channels: { phone: number; desk: number; updates: number; checkups: number };
  flow: { inquiries: number; updates: number; skipped: number; held: number; emergencies: number; handOns: number; checkupsDue: number; feedback: number };
  checkups: { due: number; needsDoctor: number; sentToEr: number; comingUp: number };
  insights: SupportInsight[];
  recentFeedback: SupportFeedbackView[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const ms = (d: unknown): number | null => (d ? new Date(d as Date).getTime() : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const avg = (xs: number[], digits: 0 | 1): number | null => {
  if (!xs.length) return null;
  const a = xs.reduce((s, x) => s + x, 0) / xs.length;
  return digits === 0 ? Math.round(a) : round1(a);
};

/** The Overview of the Patient Support page: figures, cards with 24-hour sparks (from the records), rows, rule insights and the AI day summary. */
@Injectable()
export class SupportOverviewService {
  constructor(
    private readonly tickets: SupportTicketsService,
    private readonly feedback: SupportFeedbackService,
    private readonly ai: SupportAiService,
    @InjectModel(SupportTicket.name) private readonly ticketModel: Model<SupportTicketDocument>,
    @InjectModel(PatientUpdate.name) private readonly updates: Model<PatientUpdateDocument>,
    @InjectModel(CheckupCall.name) private readonly checkupCalls: Model<CheckupCallDocument>,
    @InjectModel(SupportFeedback.name) private readonly feedbackModel: Model<SupportFeedbackDocument>,
    @InjectModel(SupportTemplate.name) private readonly templates: Model<SupportTemplateDocument>,
    @InjectModel(SupportFaq.name) private readonly faqs: Model<SupportFaqDocument>
  ) {}

  /** Real time; ticket, update, check-up and feedback times are real time, and "today" is the server's day (R15). */
  private startOfDay(now: Date): Date {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  async overview(viewer: Actor, now: Date = this.tickets.now()): Promise<SupportOverview> {
    const t0 = this.startOfDay(now).getTime();
    const nowMs = now.getTime();
    const since = new Date(Math.min(t0, hourOf(now).getTime() - (SPARK_HOURS - 1) * HOUR) - DAY - 7 * DAY);
    const sinceDay = new Date(t0 - 2 * DAY);

    // A bounded set of reads, then everything is bucketed in memory.
    const [tix, upds, fbs, checkups, summary7, recentFeedback] = await Promise.all([
      this.ticketModel
        .find({
          $or: [
            { state: { $ne: 'resolved' } },
            { openedAt: { $gte: since } },
            { resolvedAt: { $gte: since } },
            { answeredAt: { $gte: since } },
            { 'notes.at': { $gte: sinceDay } }
          ]
        })
        .lean()
        .exec(),
      this.updates
        .find({ $or: [{ status: 'held' }, { sentAt: { $gte: since } }, { status: 'skipped', updatedAt: { $gte: sinceDay } }] })
        .select('status reason sentAt updatedAt')
        .lean()
        .exec(),
      this.feedbackModel
        .find({ at: { $gte: since, $lte: now } })
        .select('overall at')
        .lean()
        .exec(),
      this.checkupCalls
        .find({
          $or: [
            { state: { $in: ['scheduled', 'due', 'calling'] } },
            { state: 'completed', $or: [{ at: { $gte: sinceDay } }, { result: { $in: ['needs-doctor', 'sent-to-er'] }, reviewedAt: null }] }
          ]
        })
        .select('state result reviewedAt at')
        .lean()
        .exec(),
      this.feedback.summary(7, now),
      this.feedback.list({ limit: 6 })
    ]);

    const sentAtOf = (u: any) => ms(u.sentAt);
    const isSent = (u: any) => (u.status === 'sample' || u.status === 'sent') && sentAtOf(u) !== null;

    // ---- the metrics, each as a window count or a snapshot at a moment ----
    const inWin = (v: unknown, from: number, to: number) => {
      const t = ms(v);
      return t !== null && t >= from && t < to;
    };
    const openAt = (t: number) => tix.filter((x) => ms(x.openedAt)! <= t && (!x.resolvedAt || ms(x.resolvedAt)! > t)).length;
    const escalatedAt = (t: number) =>
      tix.filter((x) => {
        const e = ms(x.escalatedAt);
        const a = ms(x.roundAnsweredAt);
        const r = ms(x.resolvedAt);
        return e !== null && e <= t && (a === null || a > t) && (r === null || r > t);
      }).length;
    const updatesIn = (from: number, to: number) => upds.filter((u) => isSent(u) && inWin(u.sentAt, from, to)).length;
    const responseIn = (from: number, to: number) =>
      avg(
        tix.filter((x) => !x.onTheSpot && x.firstResponseMinutes != null && inWin(x.answeredAt, from, to)).map((x) => x.firstResponseMinutes as number),
        0
      );
    const resolvedIn = (from: number, to: number) => tix.filter((x) => inWin(x.resolvedAt, from, to)).length;
    const satisfactionAt = (t: number) =>
      avg(
        fbs.filter((f) => ms(f.at)! <= t && ms(f.at)! > t - 7 * DAY).map((f) => f.overall),
        1
      );

    const end = nowMs + 1;
    const hours = Array.from({ length: SPARK_HOURS }, (_, i) => hourOf(now).getTime() - (SPARK_HOURS - 1 - i) * HOUR);
    const bucket = (i: number): [number, number] => [hours[i], Math.min(hours[i] + HOUR, end)];
    const point = (i: number) => Math.min(hours[i] + HOUR, nowMs);
    const dayAgo = nowMs - DAY;
    const card = (value: number | null, prev: number | null, spark: (number | null)[], note: string): SupportCard => ({
      value,
      total: null,
      trendPct: value === null || prev === null ? null : trendPct(value, prev),
      spark,
      note
    });
    const range = (n: number) => Array.from({ length: n }, (_, i) => i);

    const cards: Record<SupportCardKey, SupportCard> = {
      open: card(
        openAt(nowMs),
        openAt(dayAgo),
        range(SPARK_HOURS).map((i) => openAt(point(i))),
        'Not resolved'
      ),
      updatesToday: card(
        updatesIn(t0, end),
        updatesIn(t0 - DAY, dayAgo + 1),
        range(SPARK_HOURS).map((i) => updatesIn(...bucket(i))),
        'Sample or sent today'
      ),
      firstResponse: card(
        responseIn(t0, end),
        responseIn(t0 - DAY, dayAgo + 1),
        range(SPARK_HOURS).map((i) => responseIn(...bucket(i))),
        'Minutes, today'
      ),
      satisfaction: card(
        summary7.average,
        satisfactionAt(dayAgo),
        range(SPARK_HOURS).map((i) => satisfactionAt(point(i))),
        '7-day average'
      ),
      escalated: card(
        escalatedAt(nowMs),
        escalatedAt(dayAgo),
        range(SPARK_HOURS).map((i) => escalatedAt(point(i))),
        'Waiting past target'
      ),
      resolvedToday: card(
        resolvedIn(t0, end),
        resolvedIn(t0 - DAY, dayAgo + 1),
        range(SPARK_HOURS).map((i) => resolvedIn(...bucket(i))),
        'Since midnight'
      )
    };

    // ---- rows ----
    const unresolved = tix.filter((x) => x.state !== 'resolved');
    const queue = [...unresolved]
      .sort((a, b) => Number(b.priority === 'urgent') - Number(a.priority === 'urgent') || ms(a.openedAt)! - ms(b.openedAt)!)
      .slice(0, ROW_LIMIT)
      .map((x) => this.tickets.view(x));
    const todays = tix.filter((x) => ms(x.openedAt)! >= t0 && ms(x.openedAt)! <= nowMs);
    const today = [...todays]
      .sort((a, b) => ms(b.openedAt)! - ms(a.openedAt)!)
      .slice(0, ROW_LIMIT)
      .map((x) => this.tickets.view(x));
    const isEscalated = (x: any) => !!x.escalatedAt && !x.roundAnsweredAt && x.state !== 'resolved';
    const todayCounts = { all: todays.length, open: 0, inProgress: 0, waiting: 0, resolved: 0, escalated: 0 };
    for (const x of todays) {
      if (isEscalated(x)) todayCounts.escalated++;
      else if (x.state === 'open') todayCounts.open++;
      else if (x.state === 'in-progress') todayCounts.inProgress++;
      else if (x.state === 'waiting') todayCounts.waiting++;
      else todayCounts.resolved++;
    }
    const byType = TICKET_TYPES.map((type) => ({ type, count: todays.filter((x) => x.ticketType === type).length })).sort(
      (a, b) => b.count - a.count || TICKET_TYPES.indexOf(a.type) - TICKET_TYPES.indexOf(b.type)
    );

    // ---- satisfaction, channels, flow, check-ups ----
    const todayFb = fbs.filter((f) => ms(f.at)! >= t0);
    const handOns = tix.reduce((n, x) => n + (x.notes ?? []).filter((note) => note.kind === 'hand-on' && inWin(note.at, t0, end)).length, 0);
    const checkupsDone = checkups.filter((c) => c.state === 'completed' && inWin(c.at, t0, end)).length;
    const checkupsDue = checkups.filter((c) => c.state === 'due' || c.state === 'calling').length;
    const needsDoctor = checkups.filter((c) => c.state === 'completed' && c.result === 'needs-doctor' && !c.reviewedAt).length;
    const sentToEr = checkups.filter((c) => c.state === 'completed' && c.result === 'sent-to-er' && !c.reviewedAt).length;
    const updatesToday = cards.updatesToday.value ?? 0;
    const skippedToday = upds.filter((u) => u.status === 'skipped' && inWin((u as any).updatedAt, t0, end));
    const held = upds.filter((u) => u.status === 'held').length;
    const emergencies =
      checkups.filter((c) => c.result === 'sent-to-er' && inWin(c.at, t0, end)).length + todays.filter((x) => x.source === 'emergency-call').length;

    const kpis = {
      openTickets: cards.open.value ?? 0,
      avgFirstResponseMin: cards.firstResponse.value,
      satisfaction7d: cards.satisfaction.value,
      escalated: cards.escalated.value ?? 0
    };

    // ---- insights (rules, in order, at most 5) ----
    const toDo = checkupsDue;
    const noConsent = skippedToday.filter((u) => u.reason === 'no-consent').length;
    const complaints = unresolved.filter((x) => x.ticketType === 'complaint').length;
    const insights: SupportInsight[] = [];
    const add = (count: number, i: SupportInsight) => {
      if (count > 0) insights.push(i);
    };
    add(kpis.escalated, {
      key: 'escalated',
      tone: 'red',
      title: `${plural(kpis.escalated, 'ticket')} past their target`,
      sub: 'Waiting for a first answer after their due time.',
      action: { label: 'Open tickets', tab: 'tickets', filter: 'escalated' }
    });
    add(needsDoctor, {
      key: 'needs-doctor',
      tone: 'red',
      title: `${plural(needsDoctor, 'check-up call')} need a doctor`,
      sub: 'The patient reported something worrying.',
      action: { label: 'Open check-ups', tab: 'checkups', filter: 'needs-doctor' }
    });
    add(toDo, {
      key: 'checkups-to-do',
      tone: 'amber',
      title: `${plural(toDo, 'check-up call')} to do`,
      sub: 'Due now and waiting for a call.',
      action: { label: 'Open check-ups', tab: 'checkups', filter: 'to-do' }
    });
    add(noConsent, {
      key: 'no-consent',
      tone: 'amber',
      title: `${plural(noConsent, 'update')} skipped for no consent`,
      sub: 'The family has not agreed to messages.',
      action: { label: 'Open updates', tab: 'updates', filter: 'no-consent' }
    });
    add(held, {
      key: 'held',
      tone: 'amber',
      title: `${plural(held, 'update')} held`,
      sub: 'Waiting for a person to send them.',
      action: { label: 'Open updates', tab: 'updates', filter: 'held' }
    });
    add(complaints, {
      key: 'complaints',
      tone: 'violet',
      title: `${plural(complaints, 'open complaint')}`,
      sub: 'A complaint stays open until it is resolved.',
      action: { label: 'Open tickets', tab: 'tickets', filter: 'complaint' }
    });
    if (viewer.role === UserRole.ADMIN) {
      const [tt, tf] = await Promise.all([this.templates.countDocuments({ taChecked: false }), this.faqs.countDocuments({ taChecked: false })]);
      add(tt + tf, {
        key: 'tamil',
        tone: 'blue',
        title: `${plural(tt + tf, 'Tamil text')} still to check`,
        sub: 'A Tamil speaker should read them before they are used.',
        action: { label: 'Open texts', tab: 'texts' }
      });
    }

    return {
      kpis,
      cards,
      queue,
      today,
      todayCounts,
      byType,
      satisfaction: {
        average: summary7.average,
        today: avg(
          todayFb.map((f) => f.overall),
          1
        ),
        count: summary7.count,
        todayCount: todayFb.length,
        aspects: FEEDBACK_ASPECTS.map((key) => summary7.aspects.find((a) => a.key === key)!).filter(Boolean)
      },
      channels: {
        phone: todays.filter((x) => x.channel === 'phone').length,
        desk: todays.filter((x) => x.channel === 'desk').length,
        updates: updatesToday,
        checkups: checkupsDone
      },
      flow: {
        inquiries: todays.length,
        updates: updatesToday,
        skipped: skippedToday.length,
        held,
        emergencies,
        handOns,
        checkupsDue,
        feedback: todayFb.length
      },
      checkups: { due: checkupsDue, needsDoctor, sentToEr, comingUp: checkups.filter((c) => c.state === 'scheduled').length },
      insights: insights.slice(0, 5),
      recentFeedback
    };
  }

  /** "Summarise today": the counts only go to the AI. */
  async daySummary(now: Date = this.tickets.now()): Promise<SupportTextResult> {
    const t0 = this.startOfDay(now).getTime();
    const end = now.getTime() + 1;
    const [opened, resolved, escalated, sent, skipped, held, done, needsDoctor, sentToEr, summary] = await Promise.all([
      this.ticketModel.countDocuments({ openedAt: { $gte: new Date(t0), $lte: now } }),
      this.ticketModel.countDocuments({ resolvedAt: { $gte: new Date(t0), $lte: now } }),
      this.ticketModel.countDocuments({ escalatedAt: { $ne: null }, roundAnsweredAt: null, state: { $ne: 'resolved' } }),
      this.updates.countDocuments({ status: { $in: ['sample', 'sent'] }, sentAt: { $gte: new Date(t0), $lt: new Date(end) } }),
      this.updates.countDocuments({ status: 'skipped', updatedAt: { $gte: new Date(t0), $lt: new Date(end) } }),
      this.updates.countDocuments({ status: 'held' }),
      this.checkupCalls.countDocuments({ state: 'completed', at: { $gte: new Date(t0), $lt: new Date(end) } }),
      this.checkupCalls.countDocuments({ state: 'completed', result: 'needs-doctor', reviewedAt: null }),
      this.checkupCalls.countDocuments({ state: 'completed', result: 'sent-to-er', reviewedAt: null }),
      this.feedback.summary(7, now)
    ]);
    const counts: SupportDayCounts = {
      ticketsOpened: opened,
      ticketsResolved: resolved,
      ticketsEscalated: escalated,
      updatesSent: sent,
      updatesSkipped: skipped,
      updatesHeld: held,
      checkupsDone: done,
      needsDoctor,
      sentToEr,
      averageRating: summary.average
    };
    return this.ai.daySummary(counts);
  }
}
