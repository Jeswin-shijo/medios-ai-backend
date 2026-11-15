import type { Actor } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';

/** The Patient Support Agent acts as this when it writes to other agents' records. */
export const SUPPORT_ACTOR: Actor = { id: 'patient-support', name: 'Patient Support Agent', role: UserRole.STAFF };

export const LANGUAGES = ['en', 'ta'] as const;
export type Language = (typeof LANGUAGES)[number];

// ---- Tickets ----

export const TICKET_TYPES = [
  'appointment',
  'billing',
  'reports',
  'admission',
  'discharge',
  'directions',
  'medicines',
  'clinical',
  'complaint',
  'other'
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];
export const TICKET_TYPE_LABEL: Record<TicketType, string> = {
  appointment: 'Appointment',
  billing: 'Billing',
  reports: 'Reports',
  admission: 'Admission & ward',
  discharge: 'Discharge',
  directions: 'Directions & visiting',
  medicines: 'Medicines',
  clinical: 'Clinical',
  complaint: 'Complaint',
  other: 'Other'
};

export const OWNERS = ['desk', 'billing', 'ward', 'clinical', 'relations'] as const;
export type OwnerKey = (typeof OWNERS)[number];
export const OWNER_LABEL: Record<OwnerKey, string> = {
  desk: 'Front desk',
  billing: 'Billing in charge',
  ward: 'Ward nurse in charge',
  clinical: 'Duty doctor',
  relations: 'Patient relations officer'
};
/** The duty title behind each owner; the front desk has none. */
export const OWNER_TITLE: Record<OwnerKey, string | null> = {
  desk: null,
  billing: 'billing-in-charge',
  ward: 'ward-nurse-in-charge',
  clinical: 'duty-doctor',
  relations: 'patient-relations'
};
export const OWNER_LADDER: Record<OwnerKey, string> = {
  desk: 'patient-support',
  billing: 'support-billing',
  ward: 'support-ward',
  clinical: 'support-clinical',
  relations: 'patient-support'
};
/** The four escalation ladders, in the Coordinator's `{ title, waitMinutes }` form. */
export const SUPPORT_LADDERS: Record<string, { title: string; waitMinutes: number }[]> = {
  'patient-support': [
    { title: 'patient-relations', waitMinutes: 30 },
    { title: 'duty-administrator', waitMinutes: 30 },
    { title: 'medical-superintendent', waitMinutes: 0 }
  ],
  'support-billing': [
    { title: 'billing-in-charge', waitMinutes: 30 },
    { title: 'patient-relations', waitMinutes: 30 },
    { title: 'duty-administrator', waitMinutes: 30 },
    { title: 'medical-superintendent', waitMinutes: 0 }
  ],
  'support-ward': [
    { title: 'ward-nurse-in-charge', waitMinutes: 30 },
    { title: 'patient-relations', waitMinutes: 30 },
    { title: 'duty-administrator', waitMinutes: 30 },
    { title: 'medical-superintendent', waitMinutes: 0 }
  ],
  'support-clinical': [
    { title: 'duty-doctor', waitMinutes: 15 },
    { title: 'medical-superintendent', waitMinutes: 0 }
  ]
};
export const DEFAULT_OWNER_BY_TYPE: Record<TicketType, OwnerKey> = {
  appointment: 'desk',
  billing: 'billing',
  reports: 'desk',
  admission: 'ward',
  discharge: 'ward',
  directions: 'desk',
  medicines: 'desk',
  clinical: 'clinical',
  complaint: 'relations',
  other: 'desk'
};

export const TICKET_STATES = ['open', 'in-progress', 'waiting', 'resolved'] as const;
export type TicketState = (typeof TICKET_STATES)[number];
export const TICKET_STATE_LABEL: Record<TicketState, string> = {
  open: 'Open',
  'in-progress': 'In progress',
  waiting: 'Waiting on caller',
  resolved: 'Resolved'
};
export const PRIORITIES = ['urgent', 'normal'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const TICKET_SOURCES = ['desk', 'call-back', 'call-unanswered', 'emergency-call', 'feedback'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];
/** The channel a ticket from this source came by. A desk ticket's channel is chosen by the desk (default `desk`). */
export const channelOf = (source: TicketSource): 'phone' | 'desk' =>
  source === 'call-back' || source === 'call-unanswered' || source === 'emergency-call' ? 'phone' : 'desk';

// ---- Family updates ----

export const TRIGGERS = [
  'admitted',
  'transferred',
  'procedure-booked',
  'procedure-reminder',
  'procedure-done',
  'estimate-ready',
  'bill-final',
  'discharge-pack',
  'followup-booked',
  'followup-reminder'
] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const TRIGGER_LABEL: Record<Trigger, string> = {
  admitted: 'Admitted',
  transferred: 'Moved to another ward or bed',
  'procedure-booked': 'Procedure booked',
  'procedure-reminder': 'Procedure reminder',
  'procedure-done': 'Procedure done',
  'estimate-ready': 'Estimate ready',
  'bill-final': 'Final bill ready',
  'discharge-pack': 'Discharge pack',
  'followup-booked': 'Follow-up booked',
  'followup-reminder': 'Follow-up reminder'
};

export const UPDATE_STATUSES = ['waiting', 'held', 'sample', 'sent', 'failed', 'skipped'] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];
export const SKIP_REASONS = ['no-consent', 'no-phone', 'do-not-contact', 'deceased', 'messaging-off', 'trigger-off', 'stale', 'dismissed'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const HOLD_REASONS = ['missing-detail', 'no-template', 'auto-off'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

// ---- Check-up calls ----

export const CHECKUP_STATES = ['scheduled', 'due', 'calling', 'completed', 'not-reached', 'skipped'] as const;
export type CheckupState = (typeof CHECKUP_STATES)[number];
export const CHECKUP_RESULTS = ['fine', 'needs-doctor', 'sent-to-er'] as const;
export type CheckupResult = (typeof CHECKUP_RESULTS)[number];
export const CARE_GROUPS = ['general', 'cardiac'] as const;
export type CareGroup = (typeof CARE_GROUPS)[number];

export type CheckupLevel = 'ok' | 'worrying' | 'emergency';
export interface CheckupChoice {
  key: string;
  en: string;
  ta: string;
  level: CheckupLevel;
  /** A short label for the alert, on a worrying or emergency choice. */
  short?: string;
}
export interface CheckupQuestion {
  key: string;
  /** The care groups that are asked this question. */
  groups: CareGroup[];
  en: string;
  ta: string;
  choices: CheckupChoice[];
}

const BOTH: CareGroup[] = ['general', 'cardiac'];
const star = (n: number): CheckupChoice => ({ key: String(n), en: String(n), ta: String(n), level: 'ok' });

/** In asking order: medicines, symptoms, (cardiac) antiplatelets and exertion, follow-up, question, rating. */
export const CHECKUP_QUESTIONS: CheckupQuestion[] = [
  {
    key: 'medicines',
    groups: BOTH,
    en: 'Are you taking your medicines as written on the discharge summary?',
    ta: 'டிஸ்சார்ஜ் சுருக்கத்தில் எழுதியபடி உங்கள் மருந்துகளை எடுத்துக்கொள்கிறீர்களா?',
    choices: [
      { key: 'yes', en: 'Yes', ta: 'ஆம்', level: 'ok' },
      { key: 'no', en: 'No, or not sure', ta: 'இல்லை, அல்லது உறுதியாகத் தெரியவில்லை', level: 'worrying', short: 'Not taking medicines' }
    ]
  },
  {
    key: 'symptoms',
    groups: BOTH,
    en: 'Any new pain, fever or breathlessness since going home?',
    ta: 'வீட்டுக்குச் சென்றதிலிருந்து புதிதாக வலி, காய்ச்சல் அல்லது மூச்சுத்திணறல் ஏதேனும் உள்ளதா?',
    choices: [
      { key: 'none', en: 'No', ta: 'இல்லை', level: 'ok' },
      { key: 'mild', en: 'Fever or new pain', ta: 'காய்ச்சல் அல்லது புதிய வலி', level: 'worrying', short: 'Fever or new pain' },
      {
        key: 'severe',
        en: 'Chest pain, breathlessness at rest, fainting, heavy bleeding or weakness of the face, arm or leg',
        ta: 'நெஞ்சு வலி, ஓய்வில் மூச்சுத்திணறல், மயக்கம், அதிக ரத்தப்போக்கு, அல்லது முகம், கை அல்லது காலில் பலவீனம்',
        level: 'emergency',
        short: 'Chest pain, breathlessness or stroke signs'
      }
    ]
  },
  {
    key: 'antiplatelets',
    groups: ['cardiac'],
    en: 'Are you taking both blood thinners every day?',
    ta: 'இரண்டு ரத்தம் மெலிதாக்கும் மருந்துகளையும் தினமும் எடுத்துக்கொள்கிறீர்களா?',
    choices: [
      { key: 'yes', en: 'Yes', ta: 'ஆம்', level: 'ok' },
      { key: 'no', en: 'No, or not sure', ta: 'இல்லை, அல்லது உறுதியாகத் தெரியவில்லை', level: 'worrying', short: 'Not taking both blood thinners' }
    ]
  },
  {
    key: 'exertion',
    groups: ['cardiac'],
    en: 'Any chest pain or breathlessness when walking?',
    ta: 'நடக்கும்போது நெஞ்சு வலி அல்லது மூச்சுத்திணறல் ஏதேனும் உள்ளதா?',
    choices: [
      { key: 'no', en: 'No', ta: 'இல்லை', level: 'ok' },
      { key: 'walking', en: 'Yes, when walking', ta: 'ஆம், நடக்கும்போது', level: 'worrying', short: 'Chest pain on walking' },
      { key: 'rest', en: 'Yes, even at rest', ta: 'ஆம், ஓய்விலும் உள்ளது', level: 'emergency', short: 'Chest pain at rest' }
    ]
  },
  {
    key: 'followup',
    groups: BOTH,
    en: 'Do you know when your follow-up is?',
    ta: 'உங்கள் பின்தொடர்வு பரிசோதனை எப்போது என்று தெரியுமா?',
    choices: [
      { key: 'yes', en: 'Yes', ta: 'ஆம்', level: 'ok' },
      { key: 'no', en: 'No', ta: 'இல்லை', level: 'ok' }
    ]
  },
  {
    key: 'question',
    groups: BOTH,
    en: 'Any questions for the doctor?',
    ta: 'மருத்துவரிடம் கேட்க ஏதேனும் கேள்விகள் உள்ளதா?',
    choices: [
      { key: 'no', en: 'No', ta: 'இல்லை', level: 'ok' },
      { key: 'yes', en: 'Yes', ta: 'ஆம்', level: 'worrying', short: 'Has a question for the doctor' }
    ]
  },
  {
    key: 'rating',
    groups: BOTH,
    en: 'How would you rate your stay, 1 to 5?',
    ta: 'உங்கள் மருத்துவமனை அனுபவத்தை 1 முதல் 5 வரை மதிப்பிடுங்கள்.',
    choices: [1, 2, 3, 4, 5].map(star)
  }
];

/** The questions for a care group, in asking order. */
export const questionsFor = (group: CareGroup): CheckupQuestion[] => CHECKUP_QUESTIONS.filter((q) => q.groups.includes(group));

/** Procedures that put a patient in the cardiac group. */
export const CARDIAC_PROCEDURES = ['coronary-angiography', 'coronary-angioplasty'] as const;

/** A discharge diagnosis that puts a patient in the cardiac group. */
export const isCardiacDiagnosis = (text: string): boolean => /\bMI\b/.test(text) || /\b(infarction|angina|coronary|ACS|heart failure|stent)/i.test(text);

// ---- Settings ----

export interface SupportConfig {
  quietStart: string;
  quietEnd: string;
  staleHours: number;
  eveningAt: string;
  visitingHours: string;
  workStart: string;
  workEnd: string;
  urgentMinutes: number;
  normalHours: number;
  checkupDay: number;
  checkupFrom: string;
  checkupTo: string;
  ownerByType: Record<TicketType, OwnerKey>;
  triggers: Record<Trigger, boolean>;
}

export const DEFAULT_SUPPORT_CONFIG: SupportConfig = {
  quietStart: '21:00',
  quietEnd: '07:00',
  staleHours: 12,
  eveningAt: '18:00',
  visitingHours: '4 PM to 7 PM',
  workStart: '08:00',
  workEnd: '20:00',
  urgentMinutes: 30,
  normalHours: 4,
  checkupDay: 2,
  checkupFrom: '10:00',
  checkupTo: '18:00',
  ownerByType: { ...DEFAULT_OWNER_BY_TYPE },
  triggers: Object.fromEntries(TRIGGERS.map((t) => [t, true])) as Record<Trigger, boolean>
};
