import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import type { WardType } from '../beds/bed-types';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_ALLOWANCE, DEFAULT_CLOCKS, DEFAULT_DEPOSITS, DEFAULT_STAY, WARD_GROUPS, WardGroup } from './revenue-catalogue';

export interface RevenueConfig {
  deposits: Record<WardGroup, number>;
  stay: Record<WardType, number>;
  allowance: Record<WardType, number>;
  /** Percent of payments used before a top-up is asked for (50 to 100). */
  topupThreshold: number;
  clocks: { final: number; topup: number; refund: number };
  receiptHeader: string;
  /** The checkout grace (0 to 24 hours): a bed period that starts this soon after the stay's bill is settled is not charged. */
  graceHours: number;
}

const STAY_TYPES = Object.keys(DEFAULT_STAY).filter((t) => t !== 'emergency') as WardType[];
const CLOCKS = ['final', 'topup', 'refund'] as const;
const KNOWN = ['deposits', 'stay', 'allowance', 'topupThreshold', 'clocks', 'receiptHeader', 'graceHours'];
export const DEFAULT_RECEIPT_HEADER = "St. Mary's Multi Speciality Hospital, Nagercoil";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const validHeader = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 120;

/** The defaults, as a fresh copy. */
export function defaultRevenueConfig(): RevenueConfig {
  return {
    deposits: { ...DEFAULT_DEPOSITS },
    stay: { ...DEFAULT_STAY },
    allowance: { ...DEFAULT_ALLOWANCE },
    topupThreshold: 80,
    clocks: { ...DEFAULT_CLOCKS },
    receiptHeader: DEFAULT_RECEIPT_HEADER,
    graceHours: 4,
  };
}

/** Settings → Revenue: the saved values on top of the catalogue defaults. */
@Injectable()
export class RevenueSettingsService {
  constructor(private readonly settings: SettingsService) {}

  private async stored(): Promise<Record<string, any>> {
    const s = (await this.settings.getSettings()).revenue;
    return isObj(s) ? s : {};
  }

  /** Reads tolerate a bad stored value: it falls back to the default. */
  async get(): Promise<RevenueConfig> {
    const saved = await this.stored();
    const out = defaultRevenueConfig();
    for (const g of WARD_GROUPS) {
      const v = saved.deposits?.[g];
      if (whole(v, 0, 10_000_000)) out.deposits[g] = v;
    }
    for (const t of STAY_TYPES) {
      const s = saved.stay?.[t];
      if (whole(s, 1, 60)) out.stay[t] = s;
      const a = saved.allowance?.[t];
      if (whole(a, 0, 1_000_000)) out.allowance[t] = a;
    }
    if (whole(saved.topupThreshold, 50, 100)) out.topupThreshold = saved.topupThreshold;
    for (const c of CLOCKS) {
      const v = saved.clocks?.[c];
      if (whole(v, 1, 10080)) out.clocks[c] = v;
    }
    if (validHeader(saved.receiptHeader)) out.receiptHeader = saved.receiptHeader;
    if (whole(saved.graceHours, 0, 24)) out.graceHours = saved.graceHours;
    return out;
  }

  /** Admin only. Known keys only; anything out of range is a 400. */
  async save(actor: Actor, patch: unknown): Promise<RevenueConfig> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change revenue settings.');
    if (!isObj(patch)) throw new BadRequestException('Send the settings to change');
    for (const key of Object.keys(patch)) {
      if (!KNOWN.includes(key)) throw new BadRequestException(`"${key}" is not a revenue setting`);
    }
    const next: Record<string, any> = JSON.parse(JSON.stringify(await this.stored()));
    const section = (name: string, check: (key: string, value: unknown) => unknown) => {
      if (!(name in patch)) return;
      const v = patch[name];
      if (!isObj(v)) throw new BadRequestException(`"${name}" must be an object`);
      next[name] = { ...(next[name] ?? {}) };
      for (const [k, val] of Object.entries(v)) next[name][k] = check(k, val);
    };
    section('deposits', (k, v) => {
      if (!WARD_GROUPS.includes(k as WardGroup)) throw new BadRequestException(`"deposits.${k}" must be general, private or critical`);
      if (!whole(v, 0, 10_000_000)) throw new BadRequestException(`"deposits.${k}" must be a whole number of rupees from 0 to 1,00,00,000`);
      return v;
    });
    section('stay', (k, v) => {
      if (!STAY_TYPES.includes(k as WardType)) throw new BadRequestException(`"stay.${k}" is not a ward type with a stay`);
      if (!whole(v, 1, 60)) throw new BadRequestException(`"stay.${k}" must be a whole number of days from 1 to 60`);
      return v;
    });
    section('allowance', (k, v) => {
      if (!STAY_TYPES.includes(k as WardType)) throw new BadRequestException(`"allowance.${k}" is not a ward type with an allowance`);
      if (!whole(v, 0, 1_000_000)) throw new BadRequestException(`"allowance.${k}" must be a whole number of rupees from 0 to 10,00,000`);
      return v;
    });
    section('clocks', (k, v) => {
      if (!(CLOCKS as readonly string[]).includes(k)) throw new BadRequestException(`"clocks.${k}" must be final, topup or refund`);
      if (!whole(v, 1, 10080)) throw new BadRequestException(`"clocks.${k}" must be a whole number of minutes from 1 to 10080`);
      return v;
    });
    if ('topupThreshold' in patch) {
      if (!whole(patch.topupThreshold, 50, 100)) throw new BadRequestException('"topupThreshold" must be a whole percent from 50 to 100');
      next.topupThreshold = patch.topupThreshold;
    }
    if ('receiptHeader' in patch) {
      if (!validHeader(patch.receiptHeader)) throw new BadRequestException('"receiptHeader" must be 1 to 120 characters');
      next.receiptHeader = (patch.receiptHeader as string).trim();
    }
    if ('graceHours' in patch) {
      if (!whole(patch.graceHours, 0, 24)) throw new BadRequestException('"graceHours" must be a whole number of hours from 0 to 24');
      next.graceHours = patch.graceHours;
    }
    await this.settings.setRevenue(next as never);
    return this.get();
  }
}
