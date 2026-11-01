import { isoDate, parseIsoDay } from '../../common/utils/clinic-time';
import { GRID_MINUTES, LEAD_MINUTES, Priority, ProcedureDef, RoomDef, Skill, WINDOW_MINUTES } from './scheduling-catalogue';
import { RoomHours } from './scheduling-settings.service';
import { covers, gridStarts } from './scheduling-time';

// Pure: picks a room, a start and a team for one procedure (spec 4.3). Every time is clinic clock.

const MIN_MS = 60_000;
/** STAT looks this far ahead until the emergency rules (Task 9) make it never wait. */
const STAT_SEARCH_MINUTES = 1440;

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
  /** Live bookings (booked or in progress): they hold their room and their team. */
  bookings: { room: string; start: Date; end: Date; team: string[] }[];
  duty: DutyRow[];
  /** Booked minutes per clinic day and staff member: load['2026-09-26'][staffId]. */
  load: Record<string, Record<string, number>>;
}

export interface Plan {
  room: string;
  start: Date;
  end: Date;
  team: { role: Skill; staffId: string }[];
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

/** The first start (and the end of the window for starts) for this priority. */
export function searchWindow(priority: Priority, now: Date, earliest: Date): { first: Date; until: Date } {
  const stat = priority === 'stat';
  const floor = Math.max(now.getTime() + (stat ? 0 : LEAD_MINUTES * MIN_MS), earliest.getTime());
  const first = ceilToGrid(new Date(floor));
  const window = stat ? STAT_SEARCH_MINUTES : WINDOW_MINUTES[priority];
  return { first, until: new Date(first.getTime() + window * MIN_MS) };
}

/**
 * The earliest start on the 15-minute grid, from the later of now (plus 30 min unless STAT) and `earliest`, within the
 * priority's window, where a room of the procedure's kind and a full team are free. Null when nothing fits.
 *
 * - Room: inside its elective hours on the start's day (STAT: any hour), clear of blocks, and no booking within its
 *   turnover on either side.
 * - Team: for each role in order, a different person with the skill whose single shift window covers the whole
 *   procedure, not on another procedure then, and not in one of their own OPD sessions with bookings. Planned cases
 *   use on-site shifts only; STAT may use on-call people, after on-site ones.
 * - Among people who fit: fewest booked minutes that day, then name.
 */
export function planBooking(input: PlanInput): Plan | null {
  const { procedure, priority, roomHours, blocks, bookings } = input;
  const stat = priority === 'stat';
  const minutes = procedure.minutes;
  const rooms = input.rooms.filter((r) => r.kind === procedure.roomKind);
  if (!rooms.length || minutes <= 0) return null;

  const people = gatherPeople(input.duty, bookings, stat);
  const byRole = procedure.team.map((role) => people.filter((p) => p.skills.has(role)));
  if (byRole.some((list) => !list.length)) return null;

  const { first, until } = searchWindow(priority, input.now, input.earliest);
  for (const start of gridStarts(first, until)) {
    const s = start.getTime();
    const e = s + minutes * MIN_MS;
    for (const room of rooms) {
      const hours = roomHours[room.key] ?? { open: room.open, close: room.close, turnover: room.turnover };
      if (!stat && (s < atMinutes(start, minutesOf(hours.open)).getTime() || e > atMinutes(start, minutesOf(hours.close)).getTime())) continue;
      if (blocks.some((b) => b.room === room.key && overlaps(s, e, b.from.getTime(), b.to.getTime()))) continue;
      const turnover = hours.turnover * MIN_MS;
      if (bookings.some((b) => b.room === room.key && overlaps(s, e + turnover, b.start.getTime(), b.end.getTime() + turnover))) continue;
      const team = pickTeam(procedure.team, byRole, new Date(s), new Date(e), stat, input.load[isoDate(start)] ?? {});
      if (team) return { room: room.key, start: new Date(s), end: new Date(e), team };
    }
  }
  return null;
}

/** One entry per person, merging their on-site and on-call rows, with the procedures they are already on. */
function gatherPeople(duty: DutyRow[], bookings: PlanInput['bookings'], stat: boolean): Person[] {
  const map = new Map<string, Person>();
  for (const r of duty) {
    if (r.onCall && !stat) continue;
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
function pickTeam(roles: Skill[], byRole: Person[][], start: Date, end: Date, stat: boolean, load: Record<string, number>): Plan['team'] | null {
  const s = start.getTime();
  const e = end.getTime();
  const free = (p: Person) =>
    !p.busy.some((b) => overlaps(s, e, b.start.getTime(), b.end.getTime())) && !p.opdBusy.some((b) => overlaps(s, e, b.start.getTime(), b.end.getTime()));
  // 0 = on site, 1 = on call (STAT only), -1 = not on duty for the whole procedure.
  const rank = (p: Person) => (p.onSite.some((w) => covers(w, start, end)) ? 0 : stat && p.onCall.some((w) => covers(w, start, end)) ? 1 : -1);
  const options = byRole.map((list) =>
    list
      .map((p) => ({ p, rank: rank(p) }))
      .filter((o) => o.rank >= 0 && free(o.p))
      .sort((a, b) => a.rank - b.rank || (load[a.p.staffId] ?? 0) - (load[b.p.staffId] ?? 0) || a.p.name.localeCompare(b.p.name) || a.p.staffId.localeCompare(b.p.staffId))
      .map((o) => o.p),
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
