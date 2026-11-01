import { isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { GRID_MINUTES, LEAD_MINUTES, Priority, ProcedureDef, RoomDef, Skill, WINDOW_MINUTES } from './scheduling-catalogue';
import { RoomHours } from './scheduling-settings.service';
import { covers, gridStarts } from './scheduling-time';

// Pure: picks a room, a start and a team for one procedure (spec 4.3; 4.4 for STAT). Every time is clinic clock.

const MIN_MS = 60_000;
/** A STAT that may not bump looks this far ahead for a gap; with none, it goes after the first room's last booking (Z22). */
const STAT_GAP_MINUTES = 1440;

export interface Span {
  start: Date;
  end: Date;
}

/**
 * One person's shifts of one kind: on-site (morning, evening, night) or on call. A person may have one row of each;
 * `staffId` is the identity, so one person fills at most one role.
 */
export interface DutyRow {
  staffId: string;
  /** For the tie-break after load. */
  name: string;
  skills: string[];
  shiftWindows: Span[];
  onCall: boolean;
  /** For doctors: their own OPD session windows that hold at least one booking. */
  opdBusy: Span[];
}

/** A live booking: it holds its room (plus turnover) and its team. */
export interface HeldBooking {
  /** Needed to bump it. */
  id?: string;
  room: string;
  start: Date;
  end: Date;
  team: string[];
  /** Default 'booked'. Nobody is taken from a case in progress, and it is never bumped. */
  status?: 'booked' | 'in-progress';
  /** A booked STAT is never bumped. */
  priority?: Priority;
}

export interface PlanInput {
  /** With the admin's minutes already applied. */
  procedure: ProcedureDef;
  priority: Priority;
  earliest: Date;
  /** clinicNow(). */
  now: Date;
  roomHours: Record<string, RoomHours>;
  rooms: RoomDef[];
  blocks: { room: string; from: Date; to: Date }[];
  /** Live bookings (booked or in progress). */
  bookings: HeldBooking[];
  duty: DutyRow[];
  /** Booked minutes per clinic day and staff member: load['2026-09-26'][staffId]. */
  load: Record<string, Record<string, number>>;
  /** The rule "Emergencies may bump planned procedures": on unless false. Only a STAT reads it. */
  emergencyBump?: boolean;
}

export interface TeamSlot {
  role: Skill;
  /** Absent when nobody could fill the role. */
  staffId?: string;
  /** Only a STAT books with a role nobody can fill. */
  unfilled?: true;
}

export interface Plan {
  room: string;
  start: Date;
  end: Date;
  team: TeamSlot[];
  /** The planned cases (booked, not started, not STAT) a STAT displaces from its room or its team. Empty otherwise. */
  bump: string[];
}

interface Person {
  staffId: string;
  name: string;
  skills: Set<string>;
  onSite: Span[];
  onCall: Span[];
  opdBusy: Span[];
  busy: Span[];
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const atMinutes = (day: Date, minutes: number) => {
  const d = parseIsoDay(isoDate(day));
  d.setMinutes(minutes);
  return d;
};
const ceilToGrid = (d: Date) => gridStarts(d, new Date(d.getTime() + GRID_MINUTES * MIN_MS))[0];
const ceilToMinute = (ms: number) => Math.ceil(ms / MIN_MS) * MIN_MS;

/** The first start (and the end of the window for starts) for this priority. */
export function searchWindow(priority: Priority, now: Date, earliest: Date): { first: Date; until: Date } {
  const stat = priority === 'stat';
  const floor = Math.max(now.getTime() + (stat ? 0 : LEAD_MINUTES * MIN_MS), earliest.getTime());
  // A STAT starts to the whole minute; planned cases on the 15-minute grid.
  const first = stat ? new Date(ceilToMinute(floor)) : ceilToGrid(new Date(floor));
  const window = stat ? STAT_GAP_MINUTES : WINDOW_MINUTES[priority];
  return { first, until: new Date(first.getTime() + window * MIN_MS) };
}

/**
 * The earliest start on the 15-minute grid, from the later of now plus 30 min and `earliest`, within the priority's
 * window, where a room of the procedure's kind and a full team are free. Null when nothing fits. A STAT goes to
 * planStat instead, which never returns null.
 *
 * - Room: inside its elective hours on the start's day, clear of blocks, and no booking within its turnover on either
 *   side.
 * - Team: for each role in order, a different person with the skill whose single on-site shift window covers the
 *   whole procedure, not on another procedure then, and not in one of their own OPD sessions with bookings.
 * - Among people who fit: fewest booked minutes that day, then name.
 */
export function planBooking(input: PlanInput): Plan | null {
  if (input.priority === 'stat') return planStat(input);
  const { procedure, priority, roomHours, blocks, bookings } = input;
  const minutes = procedure.minutes;
  const rooms = input.rooms.filter((r) => r.kind === procedure.roomKind);
  if (!rooms.length || minutes <= 0) return null;

  const people = gatherPeople(input.duty, bookings, false);
  const byRole = procedure.team.map((role) => people.filter((p) => p.skills.has(role)));
  if (byRole.some((list) => !list.length)) return null;

  const { first, until } = searchWindow(priority, input.now, input.earliest);
  for (const start of gridStarts(first, until)) {
    const s = start.getTime();
    const e = s + minutes * MIN_MS;
    for (const room of rooms) {
      const hours = roomHours[room.key] ?? { open: room.open, close: room.close, turnover: room.turnover };
      if (s < atMinutes(start, minutesOf(hours.open)).getTime() || e > atMinutes(start, minutesOf(hours.close)).getTime()) continue;
      if (blocks.some((b) => b.room === room.key && overlaps(s, e, b.from.getTime(), b.to.getTime()))) continue;
      const turnover = hours.turnover * MIN_MS;
      if (bookings.some((b) => b.room === room.key && overlaps(s, e + turnover, b.start.getTime(), b.end.getTime() + turnover))) continue;
      const team = pickTeam(procedure.team, byRole, new Date(s), new Date(e), input.load[isoDate(start)] ?? {});
      if (team) return { room: room.key, start: new Date(s), end: new Date(e), team, bump: [] };
    }
  }
  return null;
}

/**
 * A STAT (spec 4.4, Ruling Z22). Never null for a procedure that has a room: it books even when a role stays unfilled.
 *
 * - Start: the later of now (to the whole minute; no lead, no grid, any hour) and the time the room is free. Blocks,
 *   cases in progress (they free the room at the later of now and their end, plus turnover) and booked STATs hold the
 *   room. Booked planned cases hold it too when bumping is off; when it is on, those overlapping
 *   [start, end + turnover) are bumped instead.
 * - Room: the earliest start, then the room that bumps fewer cases, then ROOMS order. With bumping off only starts
 *   within 24 hours count; when there are none, the kind's first room at its first free start (after its last booking).
 * - Team, for each role, the first step that has someone: 1 a free on-shift member; 2 a free on-call member; 3 a
 *   doctor inside their own OPD session (the outpatients wait); 4 with bumping on, a member of a planned case, which is
 *   then bumped. Never anyone on a case in progress or a booked STAT. Within a step: fewest booked minutes that day,
 *   then name. One person per role, as many roles filled as possible; the rest are unfilled.
 */
function planStat(input: PlanInput): Plan | null {
  const { procedure, roomHours, blocks, bookings } = input;
  const rooms = input.rooms.filter((r) => r.kind === procedure.roomKind);
  if (!rooms.length || procedure.minutes <= 0) return null;
  const bumpOn = input.emergencyBump !== false;
  const now = input.now.getTime();
  const { first, until } = searchWindow('stat', input.now, input.earliest);
  const dur = procedure.minutes * MIN_MS;
  const turnoverOf = (key: string) => (roomHours[key]?.turnover ?? input.rooms.find((r) => r.key === key)?.turnover ?? 0) * MIN_MS;
  const bumpable = (b: HeldBooking) => bumpOn && !!b.id && b.status !== 'in-progress' && b.priority !== 'stat';
  /** When a case in progress is expected to be over: its end, or now once it has overrun, plus its room's turnover. */
  const overAt = (b: HeldBooking) => Math.max(now, b.end.getTime()) + turnoverOf(b.room);

  const options = rooms.map((room) => {
    const turnover = turnoverOf(room.key);
    const mine = bookings.filter((b) => b.room === room.key);
    const holds = mine.filter((b) => !bumpable(b));
    const closed = blocks.filter((x) => x.room === room.key);
    const clash = (s: number) =>
      closed.some((x) => overlaps(s, s + dur, x.from.getTime(), x.to.getTime())) ||
      holds.some((b) => (b.status === 'in-progress' ? s < overAt(b) : overlaps(s, s + dur + turnover, b.start.getTime(), b.end.getTime() + turnover)));
    // The first free start is the earliest itself or the end of something in the way; the last of these always fits.
    const start = [first.getTime(), ...closed.map((x) => x.to.getTime()), ...holds.map((b) => (b.status === 'in-progress' ? overAt(b) : b.end.getTime() + turnover))]
      .map(ceilToMinute)
      .filter((c) => c >= first.getTime())
      .sort((a, b) => a - b)
      .find((c) => !clash(c))!;
    const bump = mine.filter((b) => bumpable(b) && overlaps(b.start.getTime(), b.end.getTime(), start, start + dur + turnover)).map((b) => b.id!);
    return { room, start, bump };
  });
  const pool = bumpOn ? options : options.filter((o) => o.start < until.getTime());
  const best = (pool.length ? pool : options.slice(0, 1)).reduce((a, b) => (b.start < a.start || (b.start === a.start && b.bump.length < a.bump.length) ? b : a));

  const s = best.start;
  const e = s + dur;
  const startAt = new Date(s);
  const endAt = new Date(e);
  const roomBumps = new Set(best.bump);
  // Who is held at [s, e): firmly (a case in progress, a booked STAT, or any case when bumping is off), or by planned
  // cases that would be bumped to free them. A case bumped from the room frees its whole team.
  const firm = new Set<string>();
  const bumpVia = new Map<string, string[]>();
  for (const b of bookings) {
    if (b.id && roomBumps.has(b.id)) continue;
    const held = b.status === 'in-progress' ? overlaps(s, e, Math.min(now, b.start.getTime()), overAt(b)) : overlaps(s, e, b.start.getTime(), b.end.getTime());
    if (!held) continue;
    for (const id of b.team) {
      if (bumpable(b)) bumpVia.set(id, [...(bumpVia.get(id) ?? []), b.id!]);
      else firm.add(id);
    }
  }
  const step = (p: Person): number => {
    const onSite = p.onSite.some((w) => covers(w, startAt, endAt));
    if ((!onSite && !p.onCall.some((w) => covers(w, startAt, endAt))) || firm.has(p.staffId)) return 0;
    if (bumpVia.has(p.staffId)) return 4;
    if (p.opdBusy.some((w) => overlaps(s, e, w.start.getTime(), w.end.getTime()))) return 3;
    return onSite ? 1 : 2;
  };
  const people = gatherPeople(input.duty, [], true);
  const steps = new Map(people.map((p) => [p.staffId, step(p)]));
  const load = input.load[isoDate(startAt)] ?? {};
  const candidates = procedure.team.map((role) =>
    people
      .filter((p) => p.skills.has(role) && steps.get(p.staffId)! > 0)
      .sort((a, b) => steps.get(a.staffId)! - steps.get(b.staffId)! || (load[a.staffId] ?? 0) - (load[b.staffId] ?? 0) || a.name.localeCompare(b.name) || a.staffId.localeCompare(b.staffId)),
  );
  const picks = fillMost(candidates);
  const team: TeamSlot[] = procedure.team.map((role, i) => {
    const p = picks[i];
    return p ? { role, staffId: p.staffId } : { role, unfilled: true };
  });
  const bump = [...best.bump];
  for (const p of picks) for (const id of (p && bumpVia.get(p.staffId)) || []) if (!bump.includes(id)) bump.push(id);
  return { room: best.room.key, start: startAt, end: endAt, team, bump };
}

/**
 * One person (or nobody) per role from each role's list in preference order: the most roles filled, and among those
 * the first in preference order, role by role.
 */
function fillMost(options: Person[][]): (Person | null)[] {
  let best: (Person | null)[] = options.map(() => null);
  let bestFilled = 0;
  const chosen: (Person | null)[] = [];
  const used = new Set<string>();
  const go = (i: number, filled: number) => {
    if (bestFilled === options.length || filled + (options.length - i) <= bestFilled) return;
    if (i === options.length) {
      best = [...chosen];
      bestFilled = filled;
      return;
    }
    for (const p of options[i]) {
      if (used.has(p.staffId)) continue;
      used.add(p.staffId);
      chosen.push(p);
      go(i + 1, filled + 1);
      chosen.pop();
      used.delete(p.staffId);
    }
    chosen.push(null);
    go(i + 1, filled);
    chosen.pop();
  };
  go(0, 0);
  return best;
}

/** One entry per person, merging their on-site and (for a STAT) on-call rows, with the procedures they are already on. */
function gatherPeople(duty: DutyRow[], bookings: PlanInput['bookings'], withOnCall: boolean): Person[] {
  const map = new Map<string, Person>();
  for (const r of duty) {
    if (r.onCall && !withOnCall) continue;
    let p = map.get(r.staffId);
    if (!p) {
      p = { staffId: r.staffId, name: r.name, skills: new Set(), onSite: [], onCall: [], opdBusy: [], busy: [] };
      map.set(r.staffId, p);
    }
    r.skills.forEach((s) => p!.skills.add(s));
    (r.onCall ? p.onCall : p.onSite).push(...r.shiftWindows);
    p.opdBusy.push(...r.opdBusy);
  }
  for (const b of bookings) for (const id of b.team) map.get(id)?.busy.push({ start: b.start, end: b.end });
  return [...map.values()];
}

/**
 * The first full team in preference order: each role takes the most preferred free person not already chosen, and
 * steps back to the next one when a later role would be left empty.
 */
function pickTeam(roles: Skill[], byRole: Person[][], start: Date, end: Date, load: Record<string, number>): { role: Skill; staffId: string }[] | null {
  const s = start.getTime();
  const e = end.getTime();
  const free = (p: Person) =>
    !p.busy.some((b) => overlaps(s, e, b.start.getTime(), b.end.getTime())) && !p.opdBusy.some((b) => overlaps(s, e, b.start.getTime(), b.end.getTime()));
  const onShift = (p: Person) => p.onSite.some((w) => covers(w, start, end));
  const options = byRole.map((list) =>
    list
      .filter((p) => onShift(p) && free(p))
      .sort((a, b) => (load[a.staffId] ?? 0) - (load[b.staffId] ?? 0) || a.name.localeCompare(b.name) || a.staffId.localeCompare(b.staffId)),
  );
  if (options.some((o) => !o.length)) return null;
  const chosen: string[] = [];
  const fill = (i: number): boolean => {
    if (i === roles.length) return true;
    for (const p of options[i]) {
      if (chosen.includes(p.staffId)) continue;
      chosen.push(p.staffId);
      if (fill(i + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  return fill(0) ? roles.map((role, i) => ({ role, staffId: chosen[i] })) : null;
}
