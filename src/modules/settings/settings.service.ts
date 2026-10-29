import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isDeepStrictEqual } from 'node:util';
import { Model } from 'mongoose';
import { HospitalSettings, HospitalSettingsDocument } from './schemas/settings.schema';
import { DEFAULT_CALL_AGENT_SETTINGS } from '../calls/call-agent-settings';
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
   * Only an admin may change "Allocate beds automatically": a save from anyone else that
   * carries the stored value (or leaves it out) goes through.
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
    for (const section of SECTIONS) {
      const patch = (updates as any)?.[section];
      if (patch && typeof patch === 'object') {
        settings.set(section, { ...(settings.get(section) ?? {}), ...patch });
      }
    }
    return settings.save();
  }
}
