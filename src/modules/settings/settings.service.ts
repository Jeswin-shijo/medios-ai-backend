import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HospitalSettings, HospitalSettingsDocument } from './schemas/settings.schema';

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
    return settings;
  }

  /** Merges each supplied section over the stored one; unknown sections are ignored. */
  async updateSettings(updates: Partial<HospitalSettings>): Promise<HospitalSettings> {
    const settings = (await this.settingsModel.findOne().exec()) ?? new this.settingsModel(DEFAULT_SETTINGS);
    for (const section of SECTIONS) {
      const patch = (updates as any)?.[section];
      if (patch && typeof patch === 'object') {
        settings.set(section, { ...(settings.get(section) ?? {}), ...patch });
      }
    }
    return settings.save();
  }
}
