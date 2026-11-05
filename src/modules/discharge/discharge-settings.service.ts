import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { DEFAULT_DISCHARGE_CONFIG, DischargeConfig } from './discharge-catalogue';
import { isHhmm } from './discharge-time';

const KNOWN: (keyof DischargeConfig)[] = ['leaveMinutes', 'summaryMinutes', 'reminderTime', 'warningSigns', 'gatePassHeader'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const validSigns = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 1000;
const validHeader = (v: unknown): v is string => typeof v === 'string' && v.trim().length <= 120;

/** Settings → Discharge: the saved values on top of the catalogue defaults. */
@Injectable()
export class DischargeSettingsService {
  constructor(private readonly settings: SettingsService) {}

  private async stored(): Promise<Record<string, unknown>> {
    const s = (await this.settings.getSettings()).discharge;
    return isObj(s) ? s : {};
  }

  /** Reads tolerate a bad stored value: it falls back to the default. */
  async get(): Promise<DischargeConfig> {
    const saved = await this.stored();
    const out: DischargeConfig = { ...DEFAULT_DISCHARGE_CONFIG };
    if (whole(saved.leaveMinutes, 30, 720)) out.leaveMinutes = saved.leaveMinutes;
    if (whole(saved.summaryMinutes, 15, 480)) out.summaryMinutes = saved.summaryMinutes;
    if (isHhmm(saved.reminderTime)) out.reminderTime = saved.reminderTime;
    if (validSigns(saved.warningSigns)) out.warningSigns = saved.warningSigns;
    if (validHeader(saved.gatePassHeader)) out.gatePassHeader = saved.gatePassHeader;
    return out;
  }

  /** Admin only. Known keys only; anything out of range is a 400. Text is saved trimmed. */
  async save(actor: Actor, patch: Partial<DischargeConfig>): Promise<DischargeConfig> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change discharge settings.');
    if (!isObj(patch)) throw new BadRequestException('Send the settings to change');
    for (const key of Object.keys(patch)) {
      if (!KNOWN.includes(key as keyof DischargeConfig)) throw new BadRequestException(`"${key}" is not a discharge setting`);
    }
    const next: Record<string, unknown> = { ...(await this.stored()) };
    if ('leaveMinutes' in patch) {
      if (!whole(patch.leaveMinutes, 30, 720)) throw new BadRequestException('"leaveMinutes" must be a whole number of minutes from 30 to 720');
      next.leaveMinutes = patch.leaveMinutes;
    }
    if ('summaryMinutes' in patch) {
      if (!whole(patch.summaryMinutes, 15, 480)) throw new BadRequestException('"summaryMinutes" must be a whole number of minutes from 15 to 480');
      next.summaryMinutes = patch.summaryMinutes;
    }
    if ('reminderTime' in patch) {
      if (!isHhmm(patch.reminderTime)) throw new BadRequestException('"reminderTime" must be a 24-hour time from 00:00 to 23:59, as HH:MM');
      next.reminderTime = patch.reminderTime;
    }
    if ('warningSigns' in patch) {
      if (!validSigns(patch.warningSigns)) throw new BadRequestException('"warningSigns" must be 1 to 1000 characters');
      next.warningSigns = patch.warningSigns.trim();
    }
    if ('gatePassHeader' in patch) {
      if (!validHeader(patch.gatePassHeader)) throw new BadRequestException('"gatePassHeader" must be at most 120 characters');
      next.gatePassHeader = patch.gatePassHeader.trim();
    }
    await this.settings.setDischarge(next);
    return this.get();
  }
}
