import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import type { Priority } from './pharmacy-catalogue';

export type PharmacyStage = 'check' | 'issue' | 'query';
export type PharmacyTargets = Record<PharmacyStage, Record<Priority, number>>;

/** Minutes, by stage and priority. Settings → Pharmacy can change them. */
export const DEFAULT_TARGETS: PharmacyTargets = {
  check: { stat: 15, urgent: 60, routine: 240 },
  issue: { stat: 15, urgent: 60, routine: 240 },
  query: { stat: 30, urgent: 30, routine: 120 },
};
export const DEFAULT_NEAR_EXPIRY_DAYS = 90;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Settings → Pharmacy, read side: the saved values on top of the defaults. */
@Injectable()
export class PharmacySettingsService {
  constructor(private readonly settings: SettingsService) {}

  async targets(): Promise<PharmacyTargets> {
    const saved = (await this.settings.getSettings()).pharmacy?.targets ?? {};
    const out = {} as PharmacyTargets;
    for (const stage of Object.keys(DEFAULT_TARGETS) as PharmacyStage[]) {
      out[stage] = { ...DEFAULT_TARGETS[stage] };
      for (const p of Object.keys(DEFAULT_TARGETS[stage]) as Priority[]) {
        const v = saved[stage]?.[p];
        if (whole(v, 1, 1440)) out[stage][p] = v;
      }
    }
    return out;
  }

  async nearExpiryDays(): Promise<number> {
    const v = (await this.settings.getSettings()).pharmacy?.nearExpiryDays;
    return whole(v, 1, 365) ? v : DEFAULT_NEAR_EXPIRY_DAYS;
  }

  async get(): Promise<{ targets: PharmacyTargets; nearExpiryDays: number }> {
    return { targets: await this.targets(), nearExpiryDays: await this.nearExpiryDays() };
  }

  /** Admin only. Known stages and priorities, whole minutes 1 to 1440, a near-expiry window of 1 to 365 days. Anything else is a 400. */
  async save(actor: Actor, patch: unknown): Promise<{ targets: PharmacyTargets; nearExpiryDays: number }> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change pharmacy settings.');
    if (!isObj(patch)) throw new BadRequestException('Send the settings to change');
    for (const key of Object.keys(patch)) {
      if (key !== 'targets' && key !== 'nearExpiryDays') throw new BadRequestException(`"${key}" is not a pharmacy setting`);
    }
    const stored = ((await this.settings.getSettings()).pharmacy ?? {}) as { targets?: Record<string, Record<string, number>>; nearExpiryDays?: number };
    const next: { targets: Record<string, Record<string, number>>; nearExpiryDays?: number } = {
      targets: Object.fromEntries(Object.entries(stored.targets ?? {}).map(([k, v]) => [k, { ...v }])),
      nearExpiryDays: stored.nearExpiryDays,
    };
    if ('targets' in patch) {
      if (!isObj(patch.targets)) throw new BadRequestException('"targets" must be an object');
      for (const [stage, per] of Object.entries(patch.targets)) {
        if (!Object.hasOwn(DEFAULT_TARGETS, stage)) throw new BadRequestException(`"${stage}" is not a stage: use check, issue or query`);
        if (!isObj(per)) throw new BadRequestException(`"${stage}" must have stat, urgent and routine minutes`);
        for (const [priority, minutes] of Object.entries(per)) {
          if (!Object.hasOwn(DEFAULT_TARGETS.check, priority)) throw new BadRequestException(`"${stage}.${priority}" must be stat, urgent or routine`);
          if (!whole(minutes, 1, 1440)) throw new BadRequestException(`"${stage}.${priority}" must be a whole number of minutes from 1 to 1440`);
          next.targets[stage] = { ...(next.targets[stage] ?? {}), [priority]: minutes };
        }
      }
    }
    if ('nearExpiryDays' in patch) {
      if (!whole(patch.nearExpiryDays, 1, 365)) throw new BadRequestException('"nearExpiryDays" must be a whole number of days from 1 to 365');
      next.nearExpiryDays = patch.nearExpiryDays;
    }
    if (next.nearExpiryDays === undefined) delete next.nearExpiryDays;
    await this.settings.setPharmacy(next as never);
    return this.get();
  }
}
