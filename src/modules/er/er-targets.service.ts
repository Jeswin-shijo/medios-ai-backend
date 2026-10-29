import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { pathwayTargets } from './er-rules';

/** The fast-track pathway targets, in minutes from arrival, by `<pathway>.<step>` key. */
@Injectable()
export class ErTargetsService {
  constructor(private readonly settings: SettingsService) {}

  /** Every key, with the hospital's saved value or the default. */
  async getTargets(): Promise<Record<string, number>> {
    return pathwayTargets((await this.settings.getSettings()).er?.targets);
  }

  async saveTargets(actor: Actor, targets: Record<string, unknown>): Promise<Record<string, number>> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change pathway targets.');
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new BadRequestException('"targets" must be an object');
    const known = pathwayTargets();
    for (const [key, value] of Object.entries(targets)) {
      if (!Object.prototype.hasOwnProperty.call(known, key)) throw new BadRequestException(`"${key}" is not a pathway step`);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 240) {
        throw new BadRequestException(`"${key}" must be a whole number of minutes from 1 to 240`);
      }
    }
    const stored = ((await this.settings.getSettings()).er?.targets ?? {}) as Record<string, number>;
    await this.settings.updateSettings({ er: { targets: { ...stored, ...(targets as Record<string, number>) } } }, actor);
    return this.getTargets();
  }
}
