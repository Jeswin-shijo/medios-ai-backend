import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import {
  DEFAULT_CONSULT_TARGETS,
  DEFAULT_SHIFTS,
  DEFAULT_WAIT_TARGETS,
  PROCEDURES,
  Priority,
  ROOMS,
  Shift,
} from './scheduling-catalogue';

export interface RoomHours {
  open: string;
  close: string;
  turnover: number;
}

export interface SchedulingConfig {
  shifts: Record<Shift, { start: string; end: string }>;
  consultTargets: Record<Priority, number>;
  waitTargets: { stat: number; urgent: number };
  roomHours: Record<string, RoomHours>;
  procedureMinutes: Record<string, number>;
}

const SHIFTS = Object.keys(DEFAULT_SHIFTS) as Shift[];
const PRIORITIES: Priority[] = ['stat', 'urgent', 'routine'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const hhmm = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const mins = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

/** The defaults, as a fresh copy. */
export function defaultSchedulingConfig(): SchedulingConfig {
  return {
    shifts: Object.fromEntries(SHIFTS.map((s) => [s, { ...DEFAULT_SHIFTS[s] }])) as SchedulingConfig['shifts'],
    consultTargets: { ...DEFAULT_CONSULT_TARGETS },
    waitTargets: { ...DEFAULT_WAIT_TARGETS },
    roomHours: Object.fromEntries(ROOMS.map((r) => [r.key, { open: r.open, close: r.close, turnover: r.turnover }])),
    procedureMinutes: Object.fromEntries(PROCEDURES.map((p) => [p.key, p.minutes])),
  };
}

/** Settings → Scheduling: the saved values on top of the catalogue defaults. */
@Injectable()
export class SchedulingSettingsService {
  constructor(private readonly settings: SettingsService) {}

  private async stored(): Promise<Record<string, any>> {
    const s = (await this.settings.getSettings()).scheduling;
    return isObj(s) ? s : {};
  }

  /** Reads tolerate a bad stored value: it falls back to the default. */
  async get(): Promise<SchedulingConfig> {
    const saved = await this.stored();
    const out = defaultSchedulingConfig();
    for (const s of SHIFTS) {
      const v = saved.shifts?.[s];
      if (isObj(v) && hhmm(v.start) && hhmm(v.end)) out.shifts[s] = { start: v.start, end: v.end };
    }
    for (const p of PRIORITIES) {
      const v = saved.consultTargets?.[p];
      if (whole(v, 1, 1440)) out.consultTargets[p] = v;
    }
    for (const p of ['stat', 'urgent'] as const) {
      const v = saved.waitTargets?.[p];
      if (whole(v, 1, 1440)) out.waitTargets[p] = v;
    }
    for (const r of ROOMS) {
      const v = saved.roomHours?.[r.key];
      if (isObj(v) && hhmm(v.open) && hhmm(v.close) && mins(v.open) < mins(v.close) && whole(v.turnover, 0, 240)) {
        out.roomHours[r.key] = { open: v.open, close: v.close, turnover: v.turnover };
      }
    }
    for (const p of PROCEDURES) {
      const v = saved.procedureMinutes?.[p.key];
      if (whole(v, 1, 1440)) out.procedureMinutes[p.key] = v;
    }
    return out;
  }

  /** Admin only. Known keys only; whole minutes 1 to 1440; times as HH:MM. Anything else is a 400. */
  async save(actor: Actor, patch: unknown): Promise<SchedulingConfig> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change scheduling settings.');
    if (!isObj(patch)) throw new BadRequestException('Send the settings to change');
    const known = ['shifts', 'consultTargets', 'waitTargets', 'roomHours', 'procedureMinutes'];
    for (const key of Object.keys(patch)) {
      if (!known.includes(key)) throw new BadRequestException(`"${key}" is not a scheduling setting`);
    }
    const next: Record<string, any> = JSON.parse(JSON.stringify(await this.stored()));
    const section = (name: string, check: (key: string, value: unknown) => unknown) => {
      if (!(name in patch)) return;
      const v = patch[name];
      if (!isObj(v)) throw new BadRequestException(`"${name}" must be an object`);
      next[name] = { ...(next[name] ?? {}) };
      for (const [k, val] of Object.entries(v)) next[name][k] = check(k, val);
    };
    section('shifts', (k, v) => {
      if (!SHIFTS.includes(k as Shift)) throw new BadRequestException(`"${k}" is not a shift: use morning, evening, night or on-call`);
      if (!isObj(v) || !hhmm(v.start) || !hhmm(v.end)) throw new BadRequestException(`"shifts.${k}" needs start and end as HH:MM`);
      return { start: v.start, end: v.end };
    });
    section('consultTargets', (k, v) => {
      if (!PRIORITIES.includes(k as Priority)) throw new BadRequestException(`"consultTargets.${k}" must be stat, urgent or routine`);
      if (!whole(v, 1, 1440)) throw new BadRequestException(`"consultTargets.${k}" must be a whole number of minutes from 1 to 1440`);
      return v;
    });
    section('waitTargets', (k, v) => {
      if (k !== 'stat' && k !== 'urgent') throw new BadRequestException(`"waitTargets.${k}" must be stat or urgent`);
      if (!whole(v, 1, 1440)) throw new BadRequestException(`"waitTargets.${k}" must be a whole number of minutes from 1 to 1440`);
      return v;
    });
    section('roomHours', (k, v) => {
      if (!ROOMS.some((r) => r.key === k)) throw new BadRequestException(`"${k}" is not a room`);
      if (!isObj(v) || !hhmm(v.open) || !hhmm(v.close) || mins(v.open) >= mins(v.close)) {
        throw new BadRequestException(`"roomHours.${k}" needs open before close as HH:MM`);
      }
      if (!whole(v.turnover, 0, 240)) throw new BadRequestException(`"roomHours.${k}.turnover" must be a whole number of minutes from 0 to 240`);
      return { open: v.open, close: v.close, turnover: v.turnover };
    });
    section('procedureMinutes', (k, v) => {
      if (!PROCEDURES.some((p) => p.key === k)) throw new BadRequestException(`"${k}" is not a procedure`);
      if (!whole(v, 1, 1440)) throw new BadRequestException(`"procedureMinutes.${k}" must be a whole number of minutes from 1 to 1440`);
      return v;
    });
    await this.settings.setScheduling(next as never);
    return this.get();
  }
}
