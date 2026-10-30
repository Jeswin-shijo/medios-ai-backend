import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type { Priority } from './pharmacy-catalogue';

export type PharmacyStage = 'check' | 'issue' | 'query';
export type PharmacyTargets = Record<PharmacyStage, Record<Priority, number>>;

/** Minutes, by stage and priority. Settings → Pharmacy can change them (Task 7). */
export const DEFAULT_TARGETS: PharmacyTargets = {
  check: { stat: 15, urgent: 60, routine: 240 },
  issue: { stat: 15, urgent: 60, routine: 240 },
  query: { stat: 30, urgent: 30, routine: 120 },
};
export const DEFAULT_NEAR_EXPIRY_DAYS = 90;

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
}
