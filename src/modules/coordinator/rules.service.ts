import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor } from '../beds/actor';
import { SettingsService } from '../settings/settings.service';
import { UserRole } from '../users/schemas/user.schema';
import { AgentRegistry } from './agent-registry';
import { AgentKey, COMING_RULES, RuleDef } from './coordinator-types';

export interface RuleView {
  key: string;
  agent: AgentKey;
  label: string;
  description: string;
  value: boolean;
  locked: boolean;
  comingWith?: AgentKey;
}

const pathValue = (obj: any, path: string): unknown => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** The on/off coordination rules the agents register, plus the ones that come with agents not built yet. */
@Injectable()
export class RulesService {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly settings: SettingsService,
  ) {}

  private valueOf(def: RuleDef, settings: any): boolean {
    if (def.locked) return def.default;
    if (def.settingPath) {
      const v = pathValue(settings, def.settingPath);
      if (typeof v === 'boolean') return v;
    } else {
      const v = settings?.coordinator?.rules?.[def.key];
      if (typeof v === 'boolean') return v;
    }
    return def.default;
  }

  private viewOf(def: RuleDef, settings: any): RuleView {
    return { key: def.key, agent: def.agent, label: def.label, description: def.description, value: this.valueOf(def, settings), locked: !!def.locked };
  }

  async list(): Promise<RuleView[]> {
    const settings = await this.settings.getSettings();
    const registered = this.registry.rules().map((r) => this.viewOf(r, settings));
    const coming: RuleView[] = COMING_RULES.filter((c) => !this.registry.rules().some((r) => r.key === c.key)).map((c) => ({
      key: c.key, agent: c.agent, label: c.label, description: '', value: false, locked: true, comingWith: c.agent,
    }));
    return [...registered, ...coming];
  }

  async set(actor: Actor, key: string, value: boolean): Promise<RuleView> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change coordination rules.');
    const def = this.registry.rules().find((r) => r.key === key);
    if (!def) throw new NotFoundException('Rule not found');
    if (def.locked) throw new ConflictException('This rule is always on.');
    const on = !!value;
    if (def.settingPath) {
      const [section, field] = def.settingPath.split('.');
      await this.settings.updateSettings({ [section]: { [field]: on } } as any, actor);
    } else {
      const stored = ((await this.settings.getSettings()) as any).coordinator?.rules ?? {};
      // updateSettings merges one level deep, so the whole rules object goes back.
      await this.settings.updateSettings({ coordinator: { rules: { ...stored, [key]: on } } } as any, actor);
    }
    return this.viewOf(def, await this.settings.getSettings());
  }

  async isOn(key: string): Promise<boolean> {
    const def = this.registry.rules().find((r) => r.key === key);
    if (!def) return false;
    return this.valueOf(def, await this.settings.getSettings());
  }
}
