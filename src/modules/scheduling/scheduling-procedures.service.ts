import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, isValidObjectId } from 'mongoose';
import { clinicNow, clockMinutes, displayDate, displayDateTime, displayTime, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import type { Actor } from '../beds/actor';
import { CasesService } from '../coordinator/cases.service';
import { AgentKey, Priority as CasePriority } from '../coordinator/coordinator-types';
import { DEFAULT_TITLES } from '../coordinator/escalations.service';
import { MessagesService } from '../coordinator/messages.service';
import { CoordinatorCounter, CoordinatorCounterDocument } from '../coordinator/schemas/coordinator-counter.schema';
import { OpDoctor, OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { PatientsService } from '../patients/patients.service';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { Priority, ROOMS, RoomKind, SKILL_LABEL, Skill, WINDOW_MINUTES, procedureByKey, roomByKey } from './scheduling-catalogue';
import { DutyRow, Plan, PlanInput, Span, planBooking, searchWindow } from './scheduling-planner';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { shiftWindow } from './scheduling-time';
import { PROCEDURE_STATUSES, ProcedureBooking, ProcedureBookingDocument, ProcedureStatus } from './schemas/procedure-booking.schema';
import { RoomBlock, RoomBlockDocument } from './schemas/room-block.schema';
import { RosterEntry, RosterEntryDocument } from './schemas/roster-entry.schema';
import { SchedulingLock, SchedulingLockDocument } from './schemas/scheduling-lock.schema';
import { StaffMember, StaffMemberDocument } from './schemas/staff-member.schema';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const LOCK_KEY = 'procedures';
const LOCK_MS = 30_000;
/** A request younger than this is still being booked by its own call; retryWaiting leaves it alone. */
const REQUESTED_GRACE_MS = 30_000;
const TEXT_MAX = 300;
const LIST_LIMIT = 300;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRIORITIES: Priority[] = ['stat', 'urgent', 'routine'];
const CASE_PRIORITY: Record<Priority, CasePriority> = { stat: 'high', urgent: 'medium', routine: 'low' };
const WAITING: ProcedureStatus[] = ['requested', 'cant-book'];
/** They hold their room and team. */
const LIVE: ProcedureStatus[] = ['booked', 'in-progress'];
/** They count towards a person's booked minutes that day. */
const COUNTED: ProcedureStatus[] = ['booked', 'in-progress', 'done'];
const CANCELLABLE: ProcedureStatus[] = ['requested', 'cant-book', 'booked'];
const CHANGED = 'This procedure has just changed; please reload.';

/** The message each status is announced with. */
const MESSAGE: Record<ProcedureStatus, string> = {
  requested: 'scheduling.procedure-requested',
  booked: 'scheduling.procedure-booked',
  'in-progress': 'scheduling.procedure-started',
  done: 'scheduling.procedure-done',
  cancelled: 'scheduling.procedure-cancelled',
  'cant-book': 'scheduling.procedure-cant-book',
};
/** Lab and Pharmacy hear about bookings, and about the ends of them. */
const TO: Record<ProcedureStatus, AgentKey[]> = {
  requested: ['coordinator'],
  booked: ['coordinator', 'lab', 'pharmacy'],
  'in-progress': ['coordinator'],
  done: ['coordinator', 'lab', 'pharmacy'],
  cancelled: ['coordinator', 'lab', 'pharmacy'],
  'cant-book': ['coordinator'],
};
const STATUS_TEXT: Record<ProcedureStatus, string> = {
  requested: 'requested',
  booked: 'booked',
  'in-progress': 'started',
  done: 'done',
  cancelled: 'cancelled',
  'cant-book': 'waiting',
};
/** Who is asked to call a team member with no login: the OT and cath lab in charge, or the Duty administrator for imaging. */
const FALLBACK_TITLE: Record<RoomKind, string> = {
  'cath-lab': 'ot-in-charge',
  ot: 'ot-in-charge',
  procedure: 'ot-in-charge',
  xray: 'duty-administrator',
  ct: 'duty-administrator',
  ultrasound: 'duty-administrator',
};

export type TryBookOutcome = 'booked' | 'cant-book' | 'busy' | 'unchanged';

export interface ProcedureRequestInput {
  patientId: string;
  procedure: string;
  priority: Priority;
  /** A clinic day (YYYY-MM-DD) or a moment; default now. */
  earliest?: Date | string;
  note?: string;
}

export interface ProcedureListFilter {
  status?: string;
  day?: string;
  patientId?: string;
  limit?: number;
}

export interface ProcedureView {
  id: string;
  number: string;
  patientId: string;
  patientUhid: string;
  patientName: string;
  caseId: string;
  procedure: string;
  procedureName: string;
  roomKind: RoomKind | null;
  priority: Priority;
  status: ProcedureStatus;
  room: string | null;
  roomName: string | null;
  start: string | null;
  end: string | null;
  team: { role: string; roleLabel: string; staffId: string | null; name: string | null; unfilled: boolean }[];
  requestedBy: { id: string; name: string };
  note: string;
  earliest: string;
  startedAt: string | null;
  doneAt: string | null;
  cancelled: { at: string; by: string; reason: string } | null;
  history: { at: string; what: string; by: string }[];
  createdAt: string | null;
}

export interface ProcedureBoardView {
  day: string;
  rooms: {
    key: string;
    name: string;
    kind: RoomKind;
    open: string;
    close: string;
    turnover: number;
    bookings: ProcedureView[];
    blocks: { id: string; from: string; to: string; reason: string }[];
  }[];
  /** Requests not booked yet (requested or can't book). */
  waiting: ProcedureView[];
}

type Lean<T> = T & { _id: Types.ObjectId; createdAt?: Date };

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const addDays = (day: string, n: number) => {
  const d = parseIsoDay(day);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
const validDay = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !ISO_DAY.test(v) || isoDate(parseIsoDay(v)) !== v) throw new BadRequestException(`${label} must be a date as YYYY-MM-DD`);
  return v;
};
/** "Cath nurse" → "cath nurse"; an acronym such as "ENT surgeon" stays. */
const skillText = (role: string) => (SKILL_LABEL[role as Skill] ?? role).replace(/^([A-Z])(?![A-Z])/, (c) => c.toLowerCase());
const titleLabel = (key: string) => DEFAULT_TITLES.find((t) => t.key === key)?.label ?? key;

/**
 * Procedures: a doctor asks, and the agent books the earliest room, time and team the rules allow (spec 4.3). Booking is
 * claimed with a lock so two bookings never take one room. Start, Done and Cancel each tell the Coordinator.
 * Methods take the acting person; roles are checked by the routes.
 */
@Injectable()
export class SchedulingProceduresService implements OnModuleInit {
  private readonly logger = new Logger(SchedulingProceduresService.name);

  constructor(
    @InjectModel(ProcedureBooking.name) private readonly bookings: Model<ProcedureBookingDocument>,
    @InjectModel(RoomBlock.name) private readonly blocks: Model<RoomBlockDocument>,
    @InjectModel(StaffMember.name) private readonly staff: Model<StaffMemberDocument>,
    @InjectModel(RosterEntry.name) private readonly entries: Model<RosterEntryDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(OpDoctor.name) private readonly opDoctors: Model<OpDoctorDocument>,
    @InjectModel(SchedulingLock.name) private readonly locks: Model<SchedulingLockDocument>,
    @InjectModel(CoordinatorCounter.name) private readonly counters: Model<CoordinatorCounterDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly patients: PatientsService,
    private readonly cases: CasesService,
    private readonly messages: MessagesService,
    private readonly settings: SchedulingSettingsService,
  ) {}

  /** The lock relies on the unique key: make sure the index is there before the first claim. */
  async onModuleInit(): Promise<void> {
    try {
      await this.locks.init();
    } catch (e) {
      this.logger.error(`The procedures lock index could not be built: ${(e as Error).message}`);
    }
  }

  // ---------- asking ----------

  /** Opens or joins the patient's case, sends procedure-requested, then tries to book at once. */
  async request(actor: Actor, input: ProcedureRequestInput): Promise<ProcedureView> {
    const def = typeof input?.procedure === 'string' ? procedureByKey(input.procedure) : undefined;
    if (!def) throw new BadRequestException('Choose a procedure from the list');
    if (!PRIORITIES.includes(input.priority)) throw new BadRequestException('Priority must be stat, urgent or routine');
    const earliest = this.earliestOf(input.earliest);
    if (input.note !== undefined && typeof input.note !== 'string') throw new BadRequestException('The note must be text');
    const note = text(input.note);
    if (note.length > TEXT_MAX) throw new BadRequestException(`The note is at most ${TEXT_MAX} characters`);
    const patient = await this.patients.findOne(String(input.patientId));

    const { case: theCase } = await this.cases.openOrJoin({
      patientId: String(patient._id),
      patientUhid: patient.uhid,
      patientName: patient.name,
      kind: 'opd',
      priority: CASE_PRIORITY[input.priority],
      openedBy: 'scheduling',
    });
    const created = await this.bookings.create({
      number: await this.nextNumber(),
      patient: patient._id,
      patientUhid: patient.uhid,
      patientName: patient.name,
      case: theCase._id,
      procedure: def.key,
      priority: input.priority,
      status: 'requested',
      team: [],
      requestedBy: { id: actor.id, name: actor.name },
      note,
      earliest,
      history: [{ at: clinicNow(), what: 'Requested', by: actor.name }],
    });
    const id = String(created._id);
    await this.announce(id, 'requested');
    await this.tryBook(id);
    return this.get(id);
  }

  private earliestOf(v: unknown): Date {
    if (v === undefined || v === null || v === '') return clinicNow();
    if (typeof v === 'string' && ISO_DAY.test(v)) return parseIsoDay(validDay(v, '"earliest"'));
    const d = v instanceof Date ? new Date(v) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? new Date(v) : null;
    if (!d || isNaN(d.getTime())) throw new BadRequestException('"earliest" must be a date (YYYY-MM-DD) or a date and time');
    return d;
  }

  // ---------- booking ----------

  /**
   * Plans and saves one waiting request under the lock. 'busy' when another booking holds the lock (retryWaiting picks
   * it up); 'unchanged' when the request is no longer waiting.
   */
  async tryBook(id: string): Promise<TryBookOutcome> {
    if (!isValidObjectId(id)) throw new NotFoundException('Procedure not found');
    const until = await this.acquire();
    if (!until) return 'busy';
    try {
      const b = await this.bookings.findById(id).lean<Lean<ProcedureBooking>>().exec();
      if (!b) throw new NotFoundException('Procedure not found');
      if (!WAITING.includes(b.status)) return 'unchanged';
      const plan = await this.plan(b);
      if (plan) {
        const room = roomByKey(plan.room);
        const saved = await this.bookings
          .updateOne(
            { _id: b._id, status: b.status },
            {
              $set: { status: 'booked', room: plan.room, start: plan.start, end: plan.end, team: plan.team },
              $push: { history: { at: clinicNow(), what: `Booked for ${displayDateTime(plan.start)} in ${room?.name ?? plan.room}`, by: 'Scheduling Agent' } },
              $unset: { announcedAt: '' },
            },
          )
          .exec();
        if (!saved.modifiedCount) return 'unchanged';
        await this.completeWaitAlert(id);
        await this.announce(id, 'booked');
        await this.raiseTeamAlerts(id);
        return 'booked';
      }
      if (b.status === 'cant-book') return 'cant-book';
      const moved = await this.bookings
        .updateOne(
          { _id: b._id, status: 'requested' },
          { $set: { status: 'cant-book' }, $push: { history: { at: clinicNow(), what: "Can't book yet", by: 'Scheduling Agent' } }, $unset: { announcedAt: '' } },
        )
        .exec();
      if (!moved.modifiedCount) return 'unchanged';
      await this.announce(id, 'cant-book');
      await this.raiseWaitAlert(id);
      return 'cant-book';
    } finally {
      await this.release(until);
    }
  }

  /** Tries every waiting request again, oldest first: every can't-book, and requests left waiting by a busy lock. Returns how many booked. */
  async retryWaiting(): Promise<number> {
    const young = new Date(Date.now() - REQUESTED_GRACE_MS);
    const waiting = await this.bookings
      .find({ $or: [{ status: 'cant-book' }, { status: 'requested', createdAt: { $lte: young } }] })
      .sort({ createdAt: 1, _id: 1 })
      .select('_id')
      .lean()
      .exec();
    let booked = 0;
    for (const w of waiting) {
      const outcome = await this.tryBook(String(w._id));
      if (outcome === 'busy') break; // someone else is booking; the next pass carries on
      if (outcome === 'booked') booked++;
    }
    return booked;
  }

  /** Claims the lock (real time) or returns null when someone holds it. A duplicate key on the upsert means it is held. */
  private async acquire(): Promise<Date | null> {
    const now = new Date();
    const until = new Date(now.getTime() + LOCK_MS);
    try {
      await this.locks.findOneAndUpdate({ key: LOCK_KEY, until: { $lt: now } }, { $set: { until } }, { upsert: true, new: true }).exec();
      return until;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return null;
      throw e;
    }
  }

  /** Lets go of our own claim only: one that lapsed and was taken by someone else is theirs. */
  private async release(until: Date): Promise<void> {
    try {
      await this.locks.deleteOne({ key: LOCK_KEY, until }).exec();
    } catch (e) {
      this.logger.warn(`Releasing the procedures lock failed (it lapses in ${LOCK_MS / 1000} s): ${(e as Error).message}`);
    }
  }

  /** Gathers what the planner needs for this request (clinic clock) and asks it. The team comes back with names. */
  private async plan(b: Lean<ProcedureBooking>): Promise<(Omit<Plan, 'team'> & { team: { role: Skill; staffId: string; name: string }[] }) | null> {
    const base = procedureByKey(b.procedure);
    if (!base) return null;
    const cfg = await this.settings.get();
    const procedure = { ...base, minutes: cfg.procedureMinutes[base.key] ?? base.minutes };
    const now = clinicNow();
    const { first, until } = searchWindow(b.priority, now, new Date(b.earliest));
    const firstDay = isoDate(first);
    const lastDay = isoDate(new Date(until.getTime() + procedure.minutes * MIN_MS));
    const rangeFrom = parseIsoDay(firstDay);
    const rangeTo = parseIsoDay(addDays(lastDay, 1));

    const [blocks, held, entries] = await Promise.all([
      this.blocks.find({ from: { $lt: rangeTo }, to: { $gt: rangeFrom } }).lean().exec(),
      // A day either side covers turnover and the day's load.
      this.bookings
        .find({ _id: { $ne: b._id }, status: { $in: COUNTED }, start: { $lt: new Date(rangeTo.getTime() + DAY_MS) }, end: { $gt: new Date(rangeFrom.getTime() - DAY_MS) } })
        .lean<Lean<ProcedureBooking>[]>()
        .exec(),
      // A night or on-call entry dated the day before runs into the first day.
      this.entries.find({ date: { $gte: addDays(firstDay, -1), $lte: lastDay } }).lean().exec(),
    ]);
    const people = new Map(
      (await this.staff.find({ _id: { $in: entries.map((e) => e.staff) }, active: true }).lean().exec()).map((s) => [String(s._id), s]),
    );
    const opdBusy = await this.opdBusy([...people.values()].map((s) => s.userId).filter((u): u is string => !!u), firstDay, lastDay);

    const rows = new Map<string, DutyRow>();
    for (const e of entries) {
      const person = people.get(String(e.staff));
      if (!person) continue;
      const onCall = e.shift === 'on-call';
      const key = `${person._id}|${onCall}`;
      let row = rows.get(key);
      if (!row) {
        row = { staffId: String(person._id), name: person.name, skills: person.skills, shiftWindows: [], onCall, opdBusy: (person.userId && opdBusy.get(person.userId)) || [] };
        rows.set(key, row);
      }
      row.shiftWindows.push(shiftWindow(e.date, e.shift, cfg.shifts));
    }

    const load: PlanInput['load'] = {};
    for (const h of held) {
      if (!h.start || !h.end) continue;
      const day = (load[isoDate(h.start)] ??= {});
      const minutes = (new Date(h.end).getTime() - new Date(h.start).getTime()) / MIN_MS;
      for (const t of h.team) if (t.staffId) day[t.staffId] = (day[t.staffId] ?? 0) + minutes;
    }

    const plan = planBooking({
      procedure,
      priority: b.priority,
      earliest: new Date(b.earliest),
      now,
      roomHours: cfg.roomHours,
      rooms: ROOMS,
      blocks: blocks.map((x) => ({ room: x.room, from: x.from, to: x.to })),
      bookings: held
        .filter((h) => LIVE.includes(h.status) && h.room && h.start && h.end)
        .map((h) => ({ room: h.room!, start: h.start!, end: h.end!, team: h.team.map((t) => t.staffId).filter((s): s is string => !!s) })),
      duty: [...rows.values()],
      load,
    });
    if (!plan) return null;
    return { ...plan, team: plan.team.map((t) => ({ ...t, name: people.get(t.staffId)?.name ?? '' })) };
  }

  /**
   * For each login, the windows of its OP doctor's sessions, from `firstDay` to `lastDay`, that hold at least one live
   * (not canceled) appointment. The staff member and the OP doctor are the same person when their logins match.
   */
  private async opdBusy(userIds: string[], firstDay: string, lastDay: string): Promise<Map<string, Span[]>> {
    const out = new Map<string, Span[]>();
    if (!userIds.length) return out;
    const doctors = await this.opDoctors.find({ userId: { $in: userIds }, active: true }).lean().exec();
    if (!doctors.length) return out;
    const days: string[] = [];
    for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) days.push(d);
    const appointments = await this.appointments
      .find({ doctorId: { $in: doctors.map((d) => String(d._id)) }, date: { $in: days }, status: { $ne: 'Canceled' } }, { doctorId: 1, date: 1, time: 1 })
      .lean()
      .exec();
    for (const doctor of doctors) {
      const mine = appointments.filter((a) => a.doctorId === String(doctor._id));
      for (const day of days) {
        const weekday = parseIsoDay(day).getDay();
        const minutes = mine.filter((a) => a.date === day).map((a) => clockMinutes(a.time));
        for (const s of doctor.sessions ?? []) {
          if (!s.days.includes(weekday)) continue;
          const from = Number(s.start.slice(0, 2)) * 60 + Number(s.start.slice(3, 5));
          const to = Number(s.end.slice(0, 2)) * 60 + Number(s.end.slice(3, 5));
          if (!minutes.some((t) => t >= from && t < to)) continue;
          const start = parseIsoDay(day);
          start.setMinutes(from);
          const end = parseIsoDay(day);
          end.setMinutes(to);
          const list = out.get(doctor.userId!) ?? [];
          list.push({ start, end });
          out.set(doctor.userId!, list);
        }
      }
    }
    return out;
  }

  // ---------- start, done, cancel ----------

  async start(actor: Actor, id: string): Promise<ProcedureView> {
    const b = await this.load(id);
    if (b.status !== 'booked') throw new BadRequestException(`A ${STATUS_TEXT[b.status]} procedure can't be started.`);
    const done = await this.bookings
      .updateOne(
        { _id: b._id, status: 'booked' },
        { $set: { status: 'in-progress', startedAt: clinicNow() }, $push: { history: { at: clinicNow(), what: 'Started', by: actor.name } }, $unset: { announcedAt: '' } },
      )
      .exec();
    if (!done.modifiedCount) throw new ConflictException(CHANGED);
    await this.announce(id, 'in-progress');
    return this.get(id);
  }

  async done(actor: Actor, id: string, note?: string): Promise<ProcedureView> {
    if (note !== undefined && typeof note !== 'string') throw new BadRequestException('The note must be text');
    const clean = text(note);
    if (clean.length > TEXT_MAX) throw new BadRequestException(`The note is at most ${TEXT_MAX} characters`);
    const b = await this.load(id);
    if (b.status !== 'in-progress') throw new BadRequestException(`Only a started procedure can be marked done; this one is ${STATUS_TEXT[b.status]}.`);
    const saved = await this.bookings
      .updateOne(
        { _id: b._id, status: 'in-progress' },
        { $set: { status: 'done', doneAt: clinicNow() }, $push: { history: { at: clinicNow(), what: clean ? `Done: ${clean}` : 'Done', by: actor.name } }, $unset: { announcedAt: '' } },
      )
      .exec();
    if (!saved.modifiedCount) throw new ConflictException(CHANGED);
    await this.announce(id, 'done');
    await this.completeTeamAlerts(id);
    return this.get(id);
  }

  /** Frees the room and the team, then gives waiting requests another try. */
  async cancel(actor: Actor, id: string, reason: string): Promise<ProcedureView> {
    const why = text(reason);
    if (!why || why.length > TEXT_MAX) throw new BadRequestException(`Give a reason of 1 to ${TEXT_MAX} characters`);
    const b = await this.load(id);
    if (!CANCELLABLE.includes(b.status)) throw new BadRequestException(`A ${STATUS_TEXT[b.status]} procedure can't be cancelled.`);
    const at = clinicNow();
    const saved = await this.bookings
      .updateOne(
        { _id: b._id, status: b.status },
        {
          $set: { status: 'cancelled', cancelled: { at, by: actor.name, reason: why } },
          $push: { history: { at, what: `Cancelled: ${why}`, by: actor.name } },
          $unset: { announcedAt: '' },
        },
      )
      .exec();
    if (!saved.modifiedCount) throw new ConflictException(CHANGED);
    await this.completeWaitAlert(id);
    await this.completeTeamAlerts(id);
    await this.announce(id, 'cancelled');
    if (b.status === 'booked') {
      try {
        await this.retryWaiting();
      } catch (e) {
        this.logger.error(`Retrying waiting procedures after a cancel failed: ${(e as Error).message}`);
      }
    }
    return this.get(id);
  }

  // ---------- reads ----------

  async get(id: string): Promise<ProcedureView> {
    return this.view(await this.load(id));
  }

  async list(filter: ProcedureListFilter = {}): Promise<ProcedureView[]> {
    const q: Record<string, unknown> = {};
    if (filter.status !== undefined) {
      if (!(PROCEDURE_STATUSES as readonly string[]).includes(filter.status)) throw new BadRequestException(`"status" must be one of ${PROCEDURE_STATUSES.join(', ')}`);
      q.status = filter.status;
    }
    if (filter.day !== undefined) {
      const day = validDay(filter.day, '"day"');
      q.start = { $gte: parseIsoDay(day), $lt: parseIsoDay(addDays(day, 1)) };
    }
    if (filter.patientId !== undefined) {
      if (!isValidObjectId(filter.patientId)) return [];
      q.patient = new Types.ObjectId(filter.patientId);
    }
    const limit = Math.min(Math.max(Math.trunc(Number(filter.limit) || LIST_LIMIT), 1), LIST_LIMIT);
    const rows = await this.bookings
      .find(q)
      .sort(filter.day !== undefined ? { start: 1, _id: 1 } : { createdAt: -1, _id: -1 })
      .limit(limit)
      .lean<Lean<ProcedureBooking>[]>()
      .exec();
    return rows.map((r) => this.view(r));
  }

  /** One clinic day by room: the bookings that touch it, the blocks, and every request not booked yet. */
  async board(day: string): Promise<ProcedureBoardView> {
    const d = validDay(day, '"day"');
    const from = parseIsoDay(d);
    const to = parseIsoDay(addDays(d, 1));
    const cfg = await this.settings.get();
    const [rows, blocks, waiting] = await Promise.all([
      this.bookings.find({ status: { $in: COUNTED }, start: { $lt: to }, end: { $gt: from } }).sort({ start: 1, _id: 1 }).lean<Lean<ProcedureBooking>[]>().exec(),
      this.blocks.find({ from: { $lt: to }, to: { $gt: from } }).sort({ from: 1 }).lean().exec(),
      this.bookings.find({ status: { $in: WAITING } }).sort({ createdAt: 1, _id: 1 }).limit(LIST_LIMIT).lean<Lean<ProcedureBooking>[]>().exec(),
    ]);
    return {
      day: d,
      rooms: ROOMS.map((r) => ({
        key: r.key,
        name: r.name,
        kind: r.kind,
        ...(cfg.roomHours[r.key] ?? { open: r.open, close: r.close, turnover: r.turnover }),
        bookings: rows.filter((x) => x.room === r.key).map((x) => this.view(x)),
        blocks: blocks.filter((x) => x.room === r.key).map((x) => ({ id: String(x._id), from: iso(x.from)!, to: iso(x.to)!, reason: x.reason ?? '' })),
      })),
      waiting: waiting.map((x) => this.view(x)),
    };
  }

  private async load(id: string): Promise<Lean<ProcedureBooking>> {
    const b = isValidObjectId(id) ? await this.bookings.findById(id).lean<Lean<ProcedureBooking>>().exec() : null;
    if (!b) throw new NotFoundException('Procedure not found');
    return b;
  }

  private view(b: Lean<ProcedureBooking>): ProcedureView {
    const def = procedureByKey(b.procedure);
    const room = b.room ? roomByKey(b.room) : undefined;
    return {
      id: String(b._id),
      number: b.number,
      patientId: String(b.patient),
      patientUhid: b.patientUhid,
      patientName: b.patientName,
      caseId: String(b.case),
      procedure: b.procedure,
      procedureName: def?.name ?? b.procedure,
      roomKind: def?.roomKind ?? null,
      priority: b.priority,
      status: b.status,
      room: b.room ?? null,
      roomName: room?.name ?? null,
      start: iso(b.start),
      end: iso(b.end),
      team: (b.team ?? []).map((t) => ({
        role: t.role,
        roleLabel: SKILL_LABEL[t.role as Skill] ?? t.role,
        staffId: t.staffId ?? null,
        name: t.name ?? null,
        unfilled: !!t.unfilled,
      })),
      requestedBy: { id: b.requestedBy.id, name: b.requestedBy.name },
      note: b.note ?? '',
      earliest: iso(b.earliest)!,
      startedAt: iso(b.startedAt),
      doneAt: iso(b.doneAt),
      cancelled: b.cancelled ? { at: iso(b.cancelled.at)!, by: b.cancelled.by, reason: b.cancelled.reason } : null,
      history: (b.history ?? []).map((h) => ({ at: iso(h.at)!, what: h.what, by: h.by })),
      createdAt: iso(b.createdAt),
    };
  }

  // ---------- messages ----------

  /**
   * Sends the message for the booking's current status, when it still is `status`, then marks it sent (announcedAt).
   * A send that fails is logged: the missing announcedAt lets the reconcile pass send it again.
   */
  private async announce(id: string, status: ProcedureStatus): Promise<void> {
    const b = await this.bookings.findById(id).lean<Lean<ProcedureBooking>>().exec();
    if (!b || b.status !== status) return;
    const def = procedureByKey(b.procedure);
    const type = MESSAGE[status];
    const payload: Record<string, unknown> = { bookingId: id, number: b.number, procedure: b.procedure, priority: b.priority, status };
    if (status === 'booked') Object.assign(payload, { room: b.room, start: b.start, contrast: !!def?.contrast });
    if (status === 'cant-book') payload.dueAt = await this.waitDueAt(b.priority);
    try {
      await this.messages.send({
        case: String(b.case),
        from: 'scheduling',
        to: TO[status],
        type,
        priority: CASE_PRIORITY[b.priority],
        summary: this.summary(b, status),
        payload,
        // One message per change: the history grows with every change.
        dedupeKey: `${type}:${id}:${(b.history ?? []).length}`,
      });
      await this.bookings.updateOne({ _id: b._id, status }, { $set: { announcedAt: new Date() } }).exec();
    } catch (e) {
      this.logger.error(`Sending ${type} for ${b.number} failed; the reconcile pass will send it: ${(e as Error).message}`);
    }
  }

  /** "PR-0001: Coronary angiography booked for 26 Sep 2026, 08:30 AM in Cath lab (ROUTINE)". Never a patient name. */
  private summary(b: Lean<ProcedureBooking>, status: ProcedureStatus): string {
    const name = procedureByKey(b.procedure)?.name ?? b.procedure;
    const what: Record<ProcedureStatus, string> = {
      requested: 'requested',
      booked: `booked for ${b.start ? displayDateTime(new Date(b.start)) : ''} in ${(b.room && roomByKey(b.room)?.name) || b.room}`,
      'in-progress': 'started',
      done: 'done',
      cancelled: 'cancelled',
      'cant-book': "can't be booked yet",
    };
    return `${b.number}: ${name} ${what[status]} (${b.priority.toUpperCase()})`;
  }

  /** Real time (Z1): now plus the wait target; a routine request has none, so the end of its 14-day window. */
  private async waitDueAt(priority: Priority): Promise<Date> {
    const minutes = priority === 'routine' ? WINDOW_MINUTES.routine : (await this.settings.get()).waitTargets[priority];
    return new Date(Date.now() + minutes * MIN_MS);
  }

  private async nextNumber(): Promise<string> {
    const c = await this.counters.findOneAndUpdate({ key: 'scheduling-procedure' }, { $inc: { last: 1 } }, { upsert: true, new: true }).exec();
    return `PR-${String(c.last).padStart(4, '0')}`;
  }

  // ---------- alerts ----------

  /** "08:30 AM" today, else "08:30 AM on 27 Sep 2026" (clinic clock). */
  private when(start: Date): string {
    return isoDate(start) === isoDate(clinicNow()) ? displayTime(start) : `${displayTime(start)} on ${displayDate(start)}`;
  }

  /**
   * Tells each team member: a notice (a page when STAT) to those with a login; for those without one, a call notice to
   * the fallback title ("Call Anitha (cath nurse): ..."). One alert per booking and member.
   */
  private async raiseTeamAlerts(id: string): Promise<void> {
    const b = await this.bookings.findById(id).lean<Lean<ProcedureBooking>>().exec();
    if (!b || b.status !== 'booked' || !b.start || !b.room) return;
    const def = procedureByKey(b.procedure);
    const room = roomByKey(b.room);
    const procedureName = def?.name ?? b.procedure;
    const roomName = room?.name ?? b.room;
    const stat = b.priority === 'stat';
    const when = this.when(new Date(b.start));
    const ids = b.team.map((t) => t.staffId).filter((s): s is string => !!s && isValidObjectId(s));
    const people = new Map((await this.staff.find({ _id: { $in: ids } }).lean().exec()).map((s) => [String(s._id), s]));
    const common = { patientName: b.patientName, uhid: b.patientUhid, type: 'System', status: 'Pending', dueDateTime: displayDateTime(new Date(b.start)) };
    for (const t of b.team) {
      if (!t.staffId) continue;
      const person = people.get(t.staffId);
      const name = person?.name ?? t.name ?? 'Team member';
      let link: string;
      let fields: Record<string, unknown>;
      if (person?.userId) {
        link = `${stat ? 'scheduling-page' : 'scheduling-team'}:${id}:${t.staffId}`;
        fields = {
          title: `${stat ? 'STAT: ' : ''}${procedureName} ${b.number} at ${when}, ${roomName}`,
          subtitle: `For ${name} (${SKILL_LABEL[t.role as Skill] ?? t.role}) · ${stat ? 'paged' : b.priority.toUpperCase()}`,
          category: stat ? 'Critical' : 'System',
          priority: stat ? 'High' : 'Medium',
        };
      } else {
        const title = titleLabel(FALLBACK_TITLE[room?.kind ?? 'procedure']);
        link = `scheduling-call:${id}:${t.staffId}`;
        fields = {
          title: `Call ${name} (${skillText(t.role)}): ${procedureName} ${b.number} at ${when}, ${roomName}`,
          subtitle: `For ${title} · ${name} has no login to be told directly`,
          category: 'System',
          priority: stat ? 'High' : 'Medium',
        };
      }
      await this.alerts.updateOne({ link }, { $set: { ...common, ...fields } }, { upsert: true }).exec();
    }
    // Cancelled while the notices were written: leave none pending.
    const fresh = await this.bookings.findById(id).select('status').lean().exec();
    if (fresh?.status !== 'booked') await this.completeTeamAlerts(id);
  }

  private async completeTeamAlerts(id: string): Promise<void> {
    await this.alerts.updateMany({ link: { $regex: `^scheduling-(team|page|call):${id}:` } }, { $set: { status: 'Completed' } }).exec();
  }

  /** One "Can't book yet" alert per request, for the doctor who asked. */
  private async raiseWaitAlert(id: string): Promise<void> {
    const b = await this.bookings.findById(id).lean<Lean<ProcedureBooking>>().exec();
    if (!b || b.status !== 'cant-book') return;
    const procedureName = procedureByKey(b.procedure)?.name ?? b.procedure;
    const target = b.priority === 'routine' ? null : (await this.settings.get()).waitTargets[b.priority];
    await this.alerts
      .updateOne(
        { link: `scheduling-wait:${id}` },
        {
          $set: {
            title: `Can't book yet: ${procedureName} (${b.priority.toUpperCase()})`,
            subtitle: `For ${b.requestedBy.name} · ${b.number} · no room and team are free in time; it is tried again as things change`,
            patientName: b.patientName,
            uhid: b.patientUhid,
            type: 'System',
            category: 'System',
            priority: 'High',
            status: 'Pending',
            dueDateTime: target === null ? '' : displayDateTime(new Date(clinicNow().getTime() + target * MIN_MS)),
          },
        },
        { upsert: true },
      )
      .exec();
    // Booked or cancelled while the alert was written: leave it closed.
    const fresh = await this.bookings.findById(id).select('status').lean().exec();
    if (fresh?.status !== 'cant-book') await this.completeWaitAlert(id);
  }

  private async completeWaitAlert(id: string): Promise<void> {
    await this.alerts.updateOne({ link: `scheduling-wait:${id}` }, { $set: { status: 'Completed' } }).exec();
  }
}
