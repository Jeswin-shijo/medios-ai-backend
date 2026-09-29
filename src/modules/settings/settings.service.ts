import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { HospitalSettings, HospitalSettingsDocument } from './schemas/settings.schema';

const DEFAULT_SETTINGS = {
  profile: {
    name: 'Dr. Shajin',
    role: 'General Physician & Diabetologist',
    specialty: 'Internal Medicine',
    department: 'OPD / General Medicine',
    doctorId: 'MHK-DOC-042',
    email: 'doctor@medios.ai',
    phone: '+91 98765 43210',
    avatar: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=400&q=80',
    experienceYears: 14,
    qualification: 'MBBS, MD (General Medicine), C.Diab',
    regNumber: 'MCI-2012-84920',
  },
  hospital: {
    name: 'MediOS Multi-Speciality Hospital',
    tagLine: 'Excellence in Precision Clinical Healthcare',
    registrationNo: 'HOSP-TN-2024-0089',
    phone: '+91 44 2847 1100',
    email: 'contact@medioshospital.org',
    address: '42, Health City Boulevard, Anna Nagar, Chennai, Tamil Nadu - 600040',
    gstNumber: '33AABCM9281Q1Z6',
    website: 'https://medios-hospital.org',
  },
  aiConfig: {
    defaultModel: 'GPT-6 Astro Medical Tuned',
    confidenceThreshold: 90,
    autoSuggestCodes: true,
    enableAmbientScribe: true,
    autoDrugInteractionCheck: true,
    guidelineSourcePriority: 'National First (ICMR / MOHFW)',
  },
  clinical: {
    defaultConsultDuration: 15,
    autoGenerateBillOnRx: true,
    requireVitalsBeforeConsult: false,
    alertOnAbnormalLabs: true,
  },
  notifications: {
    smsReminders: true,
    whatsappAlerts: true,
    emailReports: true,
    criticalLabImmediateCall: true,
  },
  security: {
    twoFactorAuth: false,
    sessionTimeoutMinutes: 60,
    ipWhitelisting: false,
  },
};

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

  async updateSettings(updates: Partial<HospitalSettings>): Promise<HospitalSettings> {
    let settings = await this.settingsModel.findOne().exec();
    if (!settings) {
      settings = new this.settingsModel({ ...DEFAULT_SETTINGS, ...updates });
    } else {
      Object.assign(settings, updates);
    }
    return settings.save();
  }
}
