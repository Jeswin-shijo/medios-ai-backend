import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import { isHhmm } from '../discharge/discharge-time';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_SUPPORT_CONFIG, OWNERS, SupportConfig, TICKET_TYPES, TRIGGERS } from './support-catalogue';
import { SUP_ADMIN } from './support-roles';

const KNOWN: (keyof SupportConfig)[] = [
  'quietStart',
  'quietEnd',
  'staleHours',
  'eveningAt',
  'visitingHours',
  'workStart',
  'workEnd',
  'urgentMinutes',
  'normalHours',
  'checkupDay',
  'checkupFrom',
  'checkupTo',
  'ownerByType',
  'triggers'
];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const validVisiting = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 120;
const mins = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const validOwners = (v: unknown): v is Record<string, string> =>
  isObj(v) &&
  Object.keys(v).every((k) => (TICKET_TYPES as readonly string[]).includes(k)) &&
  Object.values(v).every((o) => (OWNERS as readonly string[]).includes(o as string));
const validTriggers = (v: unknown): v is Record<string, boolean> =>
  isObj(v) && Object.keys(v).every((k) => (TRIGGERS as readonly string[]).includes(k)) && Object.values(v).every((b) => typeof b === 'boolean');

/** Settings → Patient Support: the saved values on top of the catalogue defaults. */
@Injectable()
export class SupportSettingsService {
  constructor(private readonly settings: SettingsService) {}

  private async stored(): Promise<Record<string, unknown>> {
    const s = (await this.settings.getSettings()).support;
    return isObj(s) ? s : {};
  }

  /** Reads tolerate a bad stored value: it falls back to the default. */
  async get(): Promise<SupportConfig> {
    const saved = await this.stored();
    const d = DEFAULT_SUPPORT_CONFIG;
    const out: SupportConfig = { ...d, ownerByType: { ...d.ownerByType }, triggers: { ...d.triggers } };
    if (isHhmm(saved.quietStart)) out.quietStart = saved.quietStart;
    if (isHhmm(saved.quietEnd)) out.quietEnd = saved.quietEnd;
    if (whole(saved.staleHours, 1, 48)) out.staleHours = saved.staleHours;
    if (isHhmm(saved.eveningAt)) out.eveningAt = saved.eveningAt;
    if (validVisiting(saved.visitingHours)) out.visitingHours = saved.visitingHours.trim();
    if (isHhmm(saved.workStart) && isHhmm(saved.workEnd) && mins(saved.workStart) < mins(saved.workEnd)) {
      out.workStart = saved.workStart;
      out.workEnd = saved.workEnd;
    }
    if (whole(saved.urgentMinutes, 10, 240)) out.urgentMinutes = saved.urgentMinutes;
    if (whole(saved.normalHours, 1, 24)) out.normalHours = saved.normalHours;
    if (whole(saved.checkupDay, 1, 7)) out.checkupDay = saved.checkupDay;
    if (isHhmm(saved.checkupFrom) && isHhmm(saved.checkupTo) && mins(saved.checkupFrom) < mins(saved.checkupTo)) {
      out.checkupFrom = saved.checkupFrom;
      out.checkupTo = saved.checkupTo;
    }
    if (isObj(saved.ownerByType)) {
      for (const t of TICKET_TYPES) {
        const o = saved.ownerByType[t];
        if ((OWNERS as readonly string[]).includes(o as string)) out.ownerByType[t] = o as SupportConfig['ownerByType'][typeof t];
      }
    }
    if (isObj(saved.triggers)) {
      for (const t of TRIGGERS) if (typeof saved.triggers[t] === 'boolean') out.triggers[t] = saved.triggers[t] as boolean;
    }
    return out;
  }

  /** Admin only. Known keys only; anything out of range is a 400. */
  async save(actor: Actor, patch: Partial<SupportConfig>): Promise<SupportConfig> {
    if (!actor || !SUP_ADMIN.includes(actor.role)) throw new ForbiddenException('Only an admin can change Patient Support settings.');
    if (!isObj(patch)) throw new BadRequestException('Send the settings to change');
    for (const key of Object.keys(patch)) {
      if (!KNOWN.includes(key as keyof SupportConfig)) throw new BadRequestException(`"${key}" is not a Patient Support setting`);
    }
    const current = await this.get();
    const next: Record<string, unknown> = { ...(await this.stored()) };
    const hhmm = (key: 'quietStart' | 'quietEnd' | 'eveningAt' | 'workStart' | 'workEnd' | 'checkupFrom' | 'checkupTo') => {
      if (!(key in patch)) return;
      const v = patch[key];
      if (!isHhmm(v)) throw new BadRequestException(`"${key}" must be a 24-hour time from 00:00 to 23:59, as HH:MM`);
      next[key] = v;
    };
    hhmm('quietStart');
    hhmm('quietEnd');
    hhmm('eveningAt');
    hhmm('workStart');
    hhmm('workEnd');
    hhmm('checkupFrom');
    hhmm('checkupTo');
    const wholeKey = (key: 'staleHours' | 'urgentMinutes' | 'normalHours' | 'checkupDay', min: number, max: number) => {
      if (!(key in patch)) return;
      if (!whole(patch[key], min, max)) throw new BadRequestException(`"${key}" must be a whole number from ${min} to ${max}`);
      next[key] = patch[key];
    };
    wholeKey('staleHours', 1, 48);
    wholeKey('urgentMinutes', 10, 240);
    wholeKey('normalHours', 1, 24);
    wholeKey('checkupDay', 1, 7);
    if ('visitingHours' in patch) {
      if (!validVisiting(patch.visitingHours)) throw new BadRequestException('"visitingHours" must be 1 to 120 characters');
      next.visitingHours = patch.visitingHours.trim();
    }
    const pick = <K extends 'workStart' | 'workEnd' | 'checkupFrom' | 'checkupTo'>(k: K): string => (k in patch ? (patch[k] as string) : current[k]);
    if (mins(pick('workStart')) >= mins(pick('workEnd'))) throw new BadRequestException('"workStart" must be before "workEnd"');
    if (mins(pick('checkupFrom')) >= mins(pick('checkupTo'))) throw new BadRequestException('"checkupFrom" must be before "checkupTo"');
    if ('ownerByType' in patch) {
      const v = patch.ownerByType;
      if (!validOwners(v) || !TICKET_TYPES.every((t) => t in v)) throw new BadRequestException('"ownerByType" must give every ticket type a known owner');
      next.ownerByType = { ...v };
    }
    if ('triggers' in patch) {
      const v = patch.triggers;
      if (!validTriggers(v)) throw new BadRequestException('"triggers" must be true or false for each known trigger');
      next.triggers = { ...current.triggers, ...v };
    }
    await this.settings.setSupport(next);
    return this.get();
  }
}
