import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { appointmentStart, clinicNow, isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { hourOf, hourlySeries, trendPct } from '../../common/utils/series';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import type { StatCardData } from '../beds/bed-overview';
import { Department, DepartmentDocument } from '../opd/schemas/department.schema';
import { OpDoctor, OpDoctorDocument } from '../opd/schemas/op-doctor.schema';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { ROOMS, procedureByKey, roomByKey } from './scheduling-catalogue';
import { ConflictKind, ConflictView } from './scheduling-conflicts.service';
import { SchedulingAiService, SummaryInput, SummaryResult } from './scheduling-ai';
import { SchedulingDoctorsService } from './scheduling-doctors.service';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { ConsultRequest, ConsultRequestDocument } from './schemas/consult-request.schema';
import { ProcedureBooking, ProcedureBookingDocument } from './schemas/procedure-booking.schema';
import { RoomBlock, RoomBlockDocument } from './schemas/room-block.schema';
import { SchedulingSnapshot, SchedulingSnapshotDocument } from './schemas/scheduling-snapshot.schema';
import { WaitItem, WaitItemDocument } from './schemas/wait-item.schema';

export type { StatCardData } from '../beds/bed-overview';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SPARK_HOURS = 24;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CONFLICT_LINK = /^scheduling-conflict:([a-z-]+):(.*)$/;
/** Appointments that are not on the schedule any more. */
const GONE = ['Canceled', 'No Show'];
const WAITING = ['Waiting', 'Checked In'];
const OPEN_CONSULT = ['paged', 'accepted'];
/** Bookings that hold a room and a time. */
const HOLDS_ROOM = ['booked', 'in-progress', 'done'];
const IMAGING_KINDS = ['xray', 'ct', 'ultrasound'];

export type SchedulingCardKey = 'appointmentsToday' | 'proceduresToday' | 'openConsults' | 'waitlist' | 'conflicts';
export type SchedulingSeriesRange = '24h' | '7d';
const CARD_KEYS: SchedulingCardKey[] = ['appointmentsToday', 'proceduresToday', 'openConsults', 'waitlist', 'conflicts'];

export interface ScheduleRow {
  kind: 'opd' | 'procedure' | 'imaging' | 'consult';
  /** ISO time. */
  time: string;
  label: string;
  /** The patient's UHID, never a name. */
  who: string;
  status: string;
  doctorOrRoom: string;
}

export interface CalendarColumn {
  key: string;
  label: string;
  kind: 'doctor' | 'room';
}

export interface CalendarBlock {
  column: string;
  start: string;
  end: string;
  kind: 'opd' | 'procedure' | 'block';
  label: string;
  status: string;
}

export interface RoomUseRow {
  room: string;
  bookedMin: number;
  openMin: number;
}

export interface SchedulingOverview {
  at: string;
  day: string;
  cards: Record<SchedulingCardKey, StatCardData>;
  schedule: ScheduleRow[];
  calendar: { columns: CalendarColumn[]; blocks: CalendarBlock[] };
  roomUse: RoomUseRow[];
  conflicts: ConflictView[];
}

export type SchedulingSeriesPoint = { at: string } & Record<SchedulingCardKey, number | null>;
type Counts = Record<SchedulingCardKey, number>;

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const bump = (o: Record<string, number>, key: string, by = 1) => {
  o[key] = (o[key] ?? 0) + by;
};

/** The Scheduling page's cards, day schedule, calendar, room use and conflicts. "Today" is the clinic day. */
@Injectable()
export class SchedulingOverviewService {
  constructor(
    @InjectModel(SchedulingSnapshot.name) private readonly snapshots: Model<SchedulingSnapshotDocument>,
    @InjectModel(Appointment.name) private readonly appointments: Model<AppointmentDocument>,
    @InjectModel(ProcedureBooking.name) private readonly bookings: Model<ProcedureBookingDocument>,
    @InjectModel(RoomBlock.name) private readonly blocks: Model<RoomBlockDocument>,
    @InjectModel(ConsultRequest.name) private readonly consults: Model<ConsultRequestDocument>,
    @InjectModel(WaitItem.name) private readonly waitItems: Model<WaitItemDocument>,
    @InjectModel(OpDoctor.name) private readonly opDoctors: Model<OpDoctorDocument>,
    @InjectModel(Department.name) private readonly departments: Model<DepartmentDocument>,
    @InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>,
    private readonly doctors: SchedulingDoctorsService,
    private readonly settings: SchedulingSettingsService,
    private readonly ai: SchedulingAiService,
  ) {}

  /** Stores this hour's numbers (real clock), replacing any earlier snapshot of the same hour. */
  async snapshot(): Promise<void> {
    const at = new Date();
    const counts = await this.counts(isoDate(clinicNow()));
    await this.snapshots.updateOne({ hour: hourOf(at) }, { $set: { at, ...counts } }, { upsert: true }).exec();
  }

  async overview(day?: string): Promise<SchedulingOverview> {
    const date = this.dayOf(day);
    const real = new Date();
    const dayAgoHour = hourOf(real).getTime() - DAY_MS;
    const [counts, snaps, schedule, calendar, roomUse, conflicts] = await Promise.all([
      this.counts(date),
      this.snapshots.find({ hour: { $gte: new Date(dayAgoHour) } }).lean().exec(),
      this.scheduleRows(date),
      this.calendar(date),
      this.roomUse(date),
      this.openConflicts(),
    ]);
    const dayAgo = snaps.find((s) => s.hour.getTime() === dayAgoHour);
    const card = (field: SchedulingCardKey, note: string): StatCardData => ({
      value: counts[field],
      total: null,
      trendPct: trendPct(counts[field], dayAgo?.[field] ?? null),
      spark: hourlySeries(snaps.map((s) => ({ hour: s.hour, value: s[field] })), SPARK_HOURS, real),
      note,
    });
    return {
      at: clinicNow().toISOString(),
      day: date,
      cards: {
        appointmentsToday: card('appointmentsToday', 'outpatient appointments today'),
        proceduresToday: card('proceduresToday', 'procedures and scans booked today'),
        openConsults: card('openConsults', 'specialist consults not yet seen'),
        waitlist: card('waitlist', 'people waiting for a new time'),
        conflicts: card('conflicts', 'open scheduling conflicts'),
      },
      schedule,
      calendar,
      roomUse,
      conflicts,
    };
  }

  async series(range: SchedulingSeriesRange): Promise<{ range: SchedulingSeriesRange; points: SchedulingSeriesPoint[] }> {
    const hours = range === '7d' ? 7 * 24 : 24;
    const last = hourOf(new Date()).getTime();
    const snaps = await this.snapshots.find({ hour: { $gte: new Date(last - (hours - 1) * HOUR_MS) } }).lean().exec();
    const byHour = new Map(snaps.map((s) => [s.hour.getTime(), s]));
    const points = Array.from({ length: hours }, (_, i): SchedulingSeriesPoint => {
      const s = byHour.get(last - (hours - 1 - i) * HOUR_MS);
      const point = { at: new Date(last - (hours - 1 - i) * HOUR_MS).toISOString() } as SchedulingSeriesPoint;
      for (const k of CARD_KEYS) point[k] = s?.[k] ?? null;
      return point;
    });
    return { range, points };
  }

  /** "Summarise today": the AI sees counts only (see SummaryInput). */
  async summarise(): Promise<SummaryResult> {
    return this.ai.summarise(await this.summaryInput(isoDate(clinicNow())));
  }

  // ---------- pieces ----------

  private dayOf(day?: string): string {
    if (day === undefined) return isoDate(clinicNow());
    if (!ISO_DAY.test(day) || isoDate(parseIsoDay(day)) !== day) throw new BadRequestException('day must be a date as YYYY-MM-DD');
    return day;
  }

  private window(date: string): { from: Date; to: Date } {
    const from = parseIsoDay(date);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from, to };
  }

  private liveAppointments(date: string) {
    return this.appointments.find({ date, status: { $nin: GONE } }).lean().exec();
  }

  private dayBookings(date: string) {
    const { from, to } = this.window(date);
    return this.bookings.find({ status: { $in: HOLDS_ROOM }, start: { $gte: from, $lt: to } }).lean().exec();
  }

  private async counts(date: string): Promise<Counts> {
    const { from, to } = this.window(date);
    const [appointmentsToday, proceduresToday, openConsults, waitlist, conflicts] = await Promise.all([
      this.appointments.countDocuments({ date, status: { $nin: GONE } }).exec(),
      this.bookings.countDocuments({ status: { $in: HOLDS_ROOM }, start: { $gte: from, $lt: to } }).exec(),
      this.consults.countDocuments({ status: { $in: OPEN_CONSULT } }).exec(),
      this.waitItems.countDocuments({ status: 'open' }).exec(),
      this.alerts.countDocuments({ link: { $regex: '^scheduling-conflict:' }, status: { $ne: 'Completed' } }).exec(),
    ]);
    return { appointmentsToday, proceduresToday, openConsults, waitlist, conflicts };
  }

  private async departmentLabels(): Promise<Map<string, string>> {
    const rows = await this.departments.find({}).select('code name').lean<{ code: string; name: string }[]>().exec();
    return new Map(rows.map((d) => [d.code, d.name]));
  }

  private async scheduleRows(date: string): Promise<ScheduleRow[]> {
    const [apts, bookings, consults, depts] = await Promise.all([
      this.liveAppointments(date),
      this.dayBookings(date),
      this.consults.find({ status: { $in: OPEN_CONSULT } }).lean().exec(),
      this.departmentLabels(),
    ]);
    const rows: ScheduleRow[] = [
      ...apts.map((a): ScheduleRow => ({
        kind: 'opd',
        time: appointmentStart(a.date, a.time).toISOString(),
        label: depts.get(a.departmentCode ?? '') ?? a.departmentCode ?? 'Outpatient',
        who: a.uhid,
        status: a.status,
        doctorOrRoom: a.doctorName ?? '',
      })),
      ...bookings.map((b): ScheduleRow => {
        const room = roomByKey(b.room ?? '');
        return {
          kind: room && IMAGING_KINDS.includes(room.kind) ? 'imaging' : 'procedure',
          time: new Date(b.start!).toISOString(),
          label: procedureByKey(b.procedure)?.name ?? b.procedure,
          who: b.patientUhid,
          status: b.status,
          doctorOrRoom: room?.name ?? b.room ?? '',
        };
      }),
      ...consults.map((c): ScheduleRow => ({
        kind: 'consult',
        time: new Date(c.requestedAt).toISOString(),
        label: `Consult: ${depts.get(c.departmentCode) ?? c.departmentCode}`,
        who: c.patientUhid,
        status: c.status,
        doctorOrRoom: c.pagedTo?.name ?? '',
      })),
    ];
    return rows.sort((a, b) => a.time.localeCompare(b.time));
  }

  private async calendar(date: string): Promise<SchedulingOverview['calendar']> {
    const { from, to } = this.window(date);
    const weekday = from.getDay();
    const opds = await this.opDoctors.find({ active: true, 'sessions.days': weekday }).sort({ name: 1 }).lean().exec();
    const columns: CalendarColumn[] = [];
    const slot = new Map<string, number>();
    for (const d of opds) {
      const id = String(d._id);
      const profile = await this.doctors.profile(id);
      if (profile.leave.some((l) => l.from <= date && date <= l.to)) continue;
      slot.set(id, profile.slotMinutes);
      columns.push({ key: id, label: d.name, kind: 'doctor' });
    }
    for (const r of ROOMS) columns.push({ key: r.key, label: r.name, kind: 'room' });

    const [apts, bookings, blocks] = await Promise.all([
      this.liveAppointments(date),
      this.dayBookings(date),
      this.blocks.find({ from: { $lt: to }, to: { $gt: from } }).lean().exec(),
    ]);
    const out: CalendarBlock[] = [];
    for (const a of apts) {
      const minutes = slot.get(a.doctorId ?? '');
      if (minutes === undefined) continue;
      const start = appointmentStart(a.date, a.time);
      out.push({ column: a.doctorId!, start: start.toISOString(), end: new Date(start.getTime() + minutes * MIN_MS).toISOString(), kind: 'opd', label: a.uhid, status: a.status });
    }
    for (const b of bookings) {
      if (!b.room || !b.end) continue;
      out.push({ column: b.room, start: new Date(b.start!).toISOString(), end: new Date(b.end).toISOString(), kind: 'procedure', label: procedureByKey(b.procedure)?.name ?? b.procedure, status: b.status });
    }
    for (const k of blocks) {
      out.push({ column: k.room, start: new Date(k.from).toISOString(), end: new Date(k.to).toISOString(), kind: 'block', label: k.reason || 'Blocked', status: 'blocked' });
    }
    return { columns, blocks: out.sort((a, b) => a.start.localeCompare(b.start)) };
  }

  private async roomUse(date: string): Promise<RoomUseRow[]> {
    const [bookings, config] = await Promise.all([this.dayBookings(date), this.settings.get()]);
    return ROOMS.map((r) => {
      const hours = config.roomHours[r.key] ?? { open: r.open, close: r.close };
      const bookedMs = bookings.filter((b) => b.room === r.key && b.end).reduce((t, b) => t + (new Date(b.end!).getTime() - new Date(b.start!).getTime()), 0);
      return { room: r.key, bookedMin: Math.round(bookedMs / MIN_MS), openMin: minutesOf(hours.close) - minutesOf(hours.open) };
    });
  }

  /** The open conflict alerts, as the sweep wrote them; the overview never sweeps itself. */
  private async openConflicts(): Promise<ConflictView[]> {
    const rows = await this.alerts
      .find({ link: { $regex: '^scheduling-conflict:' }, status: { $ne: 'Completed' } })
      .sort({ createdAt: 1 })
      .lean<{ link: string; title: string; createdAt?: Date }[]>()
      .exec();
    return rows.flatMap((r) => {
      const m = CONFLICT_LINK.exec(r.link);
      return m ? [{ kind: m[1] as ConflictKind, ref: m[2], text: r.title, at: new Date(r.createdAt ?? Date.now()).toISOString() }] : [];
    });
  }

  /** Counts under fixed keys; nothing here is a name, id, number or typed text. */
  private async summaryInput(date: string): Promise<SummaryInput> {
    const now = clinicNow();
    const [apts, bookings, consults, waitlist, conflicts, depts, config] = await Promise.all([
      this.liveAppointments(date),
      this.dayBookings(date),
      this.consults.find({ status: { $in: OPEN_CONSULT.concat('seen') } }).select('priority status').lean<{ priority: string; status: string }[]>().exec(),
      this.waitItems.countDocuments({ status: 'open' }).exec(),
      this.openConflicts(),
      this.departmentLabels(),
      this.settings.get(),
    ]);
    const appointmentsByDepartment: Record<string, number> = {};
    const waits: number[] = [];
    for (const a of apts) {
      bump(appointmentsByDepartment, depts.get(a.departmentCode ?? '') ?? a.departmentCode ?? 'Outpatient');
      if (WAITING.includes(a.status)) waits.push(Math.max(0, (now.getTime() - appointmentStart(a.date, a.time).getTime()) / MIN_MS));
    }
    const conflictsByKind: Record<string, number> = {};
    for (const c of conflicts) bump(conflictsByKind, c.kind);
    const booked: Record<string, number> = {};
    const open: Record<string, number> = {};
    for (const r of ROOMS) {
      const h = config.roomHours[r.key] ?? { open: r.open, close: r.close };
      bump(open, r.kind, minutesOf(h.close) - minutesOf(h.open));
      const ms = bookings.filter((b) => b.room === r.key && b.end).reduce((t, b) => t + (new Date(b.end!).getTime() - new Date(b.start!).getTime()), 0);
      bump(booked, r.kind, ms / MIN_MS);
    }
    const roomUsePctByKind = Object.fromEntries(Object.keys(open).map((k) => [k, open[k] ? Math.round((booked[k] ?? 0) / open[k] * 100) : 0]));
    const consultsByPriorityStatus: Record<string, number> = {};
    for (const c of consults) bump(consultsByPriorityStatus, `${c.priority}/${c.status}`);
    return {
      appointmentsByDepartment,
      avgWaitMin: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
      conflictsByKind,
      waitlist,
      roomUsePctByKind,
      consultsByPriorityStatus,
    };
  }
}
