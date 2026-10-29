import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isDeepStrictEqual } from 'node:util';
import { Model } from 'mongoose';
import { HospitalSettings, HospitalSettingsDocument } from './schemas/settings.schema';
import { DEFAULT_CALL_AGENT_SETTINGS, resolveCallAgentSettings } from '../calls/call-agent-settings';
import { DEFAULT_QUEUE_SETTINGS } from '../queue/queue-settings';
import { UserRole } from '../users/schemas/user.schema';

// Used only until settings are first saved (the seed stores the demo hospital's).
// Identity fields start blank; toggles start at conservative values, and nothing
// claims a safeguard (2FA, IP restrictions) the backend does not enforce.
const DEFAULT_SETTINGS = {
  profile: {
    name: '',
    designation: '',
    credentials: '',
    regNo: '',
    email: '',
    phone: '',
    specialization: '',
    bio: '',
  },
  hospital: {
    name: '',
    address: '',
    phone: '',
    email: '',
    timeZone: '(GMT+05:30) Chennai, Kolkata, Mumbai, New Delhi',
    dateFormat: 'DD/MM/YYYY',
    timeFormat: '12 Hour (AM/PM)',
  },
  ai: {
    model: '',
    useClinicalSuggestions: false,
    autoGenerateNotes: false,
    voiceToNotes: false,
    drugInteractionAlerts: true,
    followUpSuggestions: false,
    bedSuggestions: true,
    bedAutoAllocate: true,
    responseTone: 'Professional & Concise',
    language: 'English (Auto-detect)',
  },
  notifications: {
    appointmentReminders: true,
    followUpAlerts: true,
    labResultAlerts: true,
    criticalAlerts: true,
    systemNotifications: true,
    emailNotifications: false,
    smsNotifications: false,
    pushNotifications: false,
  },
  security: {
    twoFactorAuth: false,
    sessionTimeout: '30 minutes',
    loginAlerts: false,
    ipRestrictions: false,
    auditLogAccess: false,
  },
  preferences: {
    defaultDashboard: 'Doctor Dashboard',
    itemsPerPage: 20,
    defaultPatientView: 'Summary View',
    autoSaveInterval: '30 seconds',
    enableSoundAlerts: false,
    showTipsAndGuides: true,
    compactMode: false,
  },
  callAgent: DEFAULT_CALL_AGENT_SETTINGS,
  queue: DEFAULT_QUEUE_SETTINGS,
  coordinator: { rules: {} as Record<string, boolean> },
  er: { targets: {} as Record<string, number> },
};

const SECTIONS = Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[];

@Injectable()
export class SettingsService {
  constructor(
    @InjectModel(HospitalSettings.name)
    private settingsModel: Model<HospitalSettingsDocument>,
  ) {}

  async getSettings(): Promise<HospitalSettings> {
    let settings = await this.settingsModel.findOne().exec();
    if (!settings) {
      settings = new this.settingsModel(DEFAULT_SETTINGS);
      await settings.save();
    }
    // Sections and fields added after the settings were first saved read as their defaults.
    for (const section of SECTIONS) {
      settings.set(section, { ...DEFAULT_SETTINGS[section], ...(settings.get(section) ?? {}) });
    }
    return settings;
  }

  /**
   * Merges each supplied section over the stored one, key by key; unknown sections are ignored.
   * Only an admin may change "Allocate beds automatically", coordination rules, pathway
   * targets, changes by phone and the call agent's public address: a save from anyone
   * else that carries the stored value (or leaves it out) goes through.
   */
  async updateSettings(updates: Partial<HospitalSettings>, by: { role: string }): Promise<HospitalSettings> {
    const settings = (await this.settingsModel.findOne().exec()) ?? new this.settingsModel(DEFAULT_SETTINGS);
    const autoAllocate = (updates as any)?.ai?.bedAutoAllocate;
    const storedAutoAllocate = settings.get('ai')?.bedAutoAllocate ?? DEFAULT_SETTINGS.ai.bedAutoAllocate;
    if (by?.role !== UserRole.ADMIN && autoAllocate !== undefined && autoAllocate !== storedAutoAllocate) {
      throw new ForbiddenException('Only an admin can change automatic bed allocation.');
    }
    const coordinatorPatch = (updates as any)?.coordinator;
    if (by?.role !== UserRole.ADMIN && coordinatorPatch && typeof coordinatorPatch === 'object') {
      const stored = settings.get('coordinator')?.rules ?? {};
      if (coordinatorPatch.rules !== undefined && !isDeepStrictEqual(coordinatorPatch.rules, stored)) {
        throw new ForbiddenException('Only an admin can change coordination rules.');
      }
    }
    const erPatch = (updates as any)?.er;
    if (by?.role !== UserRole.ADMIN && erPatch && typeof erPatch === 'object') {
      const stored = settings.get('er')?.targets ?? {};
      if (erPatch.targets !== undefined && !isDeepStrictEqual(erPatch.targets, stored)) {
        throw new ForbiddenException('Only an admin can change pathway targets.');
      }
    }
    const callAgentPatch = (updates as any)?.callAgent;
    if (by?.role !== UserRole.ADMIN && callAgentPatch && typeof callAgentPatch === 'object') {
      // Compared as the server reads them: the web app sends back the resolved values.
      const stored = resolveCallAgentSettings(settings.get('callAgent'));
      const wanted = resolveCallAgentSettings({ ...stored, ...callAgentPatch });
      if ('inboundChanges' in callAgentPatch && wanted.inboundChanges !== stored.inboundChanges) {
        throw new ForbiddenException('Only an admin can turn appointment changes by phone on or off.');
      }
      if ('publicApiUrl' in callAgentPatch && wanted.publicApiUrl !== stored.publicApiUrl) {
        throw new ForbiddenException("Only an admin can change the API's public address.");
      }
    }
    for (const section of SECTIONS) {
      const patch = (updates as any)?.[section];
      if (patch && typeof patch === 'object') {
        settings.set(section, { ...(settings.get(section) ?? {}), ...patch });
      }
    }
    return settings.save();
  }
}
