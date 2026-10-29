import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { CRITICAL_LIMITS, LAB_TESTS, effectiveLimits, targetMinutes, testByKey } from './lab-catalogue';

const HISTORY_KEEP = 50;

type Targets = Record<string, { stat?: number; routine?: number }>;
type Limits = Record<string, { low?: number | null; high?: number | null }>;
export interface LimitChange {
  key: string;
  from: unknown;
  to: unknown;
}
export interface LimitsHistoryEntry {
  by: string;
  at: Date;
  changes: LimitChange[];
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Settings → Lab: turnaround targets per test and critical limits per parameter. Saving is admin only. */
@Injectable()
export class LabSettingsService {
  constructor(private readonly settings: SettingsService) {}

  /** The saved overrides alone, for the catalogue helpers. */
  async overrides(): Promise<{ targets?: Targets; criticalLimits?: Limits }> {
    const lab = (await this.settings.getSettings()).lab ?? {};
    return { targets: lab.targets, criticalLimits: lab.criticalLimits };
  }

  /** Every test's STAT and routine minutes: the catalogue, with the saved values on top. */
  async getTargets(): Promise<Record<string, { stat: number; routine: number }>> {
    const { targets } = await this.overrides();
    const out: Record<string, { stat: number; routine: number }> = {};
    for (const t of LAB_TESTS) out[t.key] = { stat: targetMinutes(t.key, 'stat', targets), routine: targetMinutes(t.key, 'routine', targets) };
    return out;
  }

  async saveTargets(actor: Actor, targets: unknown): Promise<Record<string, { stat: number; routine: number }>> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change lab turnaround targets.');
    if (!isObj(targets)) throw new BadRequestException('"targets" must be an object');
    const patch: Targets = {};
    for (const [key, value] of Object.entries(targets)) {
      if (!testByKey(key)) throw new BadRequestException(`"${key}" is not a lab test`);
      if (!isObj(value)) throw new BadRequestException(`"${key}" must have stat and routine minutes`);
      patch[key] = {};
      for (const [side, minutes] of Object.entries(value)) {
        if (side !== 'stat' && side !== 'routine') throw new BadRequestException(`"${key}.${side}" must be stat or routine`);
        if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 4320) {
          throw new BadRequestException(`"${key}.${side}" must be a whole number of minutes from 1 to 4320`);
        }
        patch[key][side] = minutes;
      }
    }
    const stored = ((await this.settings.getSettings()).lab?.targets ?? {}) as Targets;
    const merged: Targets = { ...stored };
    for (const [key, v] of Object.entries(patch)) merged[key] = { ...(merged[key] ?? {}), ...v };
    await this.settings.updateSettings({ lab: { targets: merged } }, actor);
    return this.getTargets();
  }

  /** The limits in force for every critical parameter, and who changed them (newest last). */
  async getLimits(): Promise<{ limits: ReturnType<typeof effectiveLimits>; history: LimitsHistoryEntry[] }> {
    const lab = (await this.settings.getSettings()).lab ?? {};
    return { limits: effectiveLimits(lab.criticalLimits), history: (lab.limitsHistory ?? []) as LimitsHistoryEntry[] };
  }

  async saveLimits(actor: Actor, limits: unknown): Promise<{ limits: ReturnType<typeof effectiveLimits>; history: LimitsHistoryEntry[] }> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change critical limits.');
    if (!isObj(limits)) throw new BadRequestException('"limits" must be an object');
    const lab = (await this.settings.getSettings()).lab ?? {};
    const stored = (lab.criticalLimits ?? {}) as Limits;
    const before = effectiveLimits(stored);
    const patch: Limits = {};
    for (const [key, value] of Object.entries(limits)) {
      if (!has(CRITICAL_LIMITS, key)) throw new BadRequestException(`"${key}" is not a critical limit`);
      if (!isObj(value)) throw new BadRequestException(`"${key}" must have a low and a high`);
      const [test, ...rest] = key.split('.');
      const param = testByKey(test)?.params.find((p) => p.name === rest.join('.'));
      if (has(CRITICAL_LIMITS[key], 'anyAbnormalText') || param?.text) throw new BadRequestException('Text results have no numeric limits.');
      patch[key] = {};
      for (const [side, v] of Object.entries(value)) {
        if (side !== 'low' && side !== 'high') throw new BadRequestException(`"${key}.${side}" must be low or high`);
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) throw new BadRequestException(`"${key}.${side}" must be a number or null`);
        // A critical value must also be flagged, so it can't sit inside the normal range.
        const inside = v !== null && param && ((side === 'low' && param.low !== undefined && (v as number) > param.low) || (side === 'high' && param.high !== undefined && (v as number) < param.high));
        if (inside) throw new BadRequestException("A critical limit can't sit inside the normal range.");
        patch[key][side] = v as number | null;
      }
    }
    const merged: Limits = { ...stored };
    for (const [key, v] of Object.entries(patch)) merged[key] = { ...(merged[key] ?? {}), ...v };
    const after = effectiveLimits(merged);
    const changes: LimitChange[] = [];
    for (const key of Object.keys(patch)) {
      for (const side of ['low', 'high'] as const) {
        const from = before[key][side] ?? null;
        const to = after[key][side] ?? null;
        if (from !== to) changes.push({ key: `${key}.${side}`, from, to });
      }
    }
    if (!changes.length) return this.getLimits();
    const history = [...((lab.limitsHistory ?? []) as LimitsHistoryEntry[]), { by: actor.name, at: new Date(), changes }].slice(-HISTORY_KEEP);
    await this.settings.setLabLimits(merged, history);
    return this.getLimits();
  }
}
