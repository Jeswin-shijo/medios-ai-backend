import type { Trigger } from './support-catalogue';

export interface DefaultTemplate {
  key: string;
  trigger: Trigger | null;
  en: string;
  ta: string;
}
export interface DefaultFaq {
  topic: string;
  title: string;
  keywords: string[];
  en: string;
  ta: string;
}

const ANGIO_EN =
  'Please do not eat for 6 hours before; you may drink water until 2 hours before. Bring your earlier reports and your medicine list, and come 1 hour early. Ask the ward nurse which of your medicines to take that morning.';
const ANGIO_TA =
  'தயவுசெய்து 6 மணி நேரத்துக்கு முன்பிருந்து சாப்பிட வேண்டாம்; 2 மணி நேரத்துக்கு முன்பு வரை தண்ணீர் குடிக்கலாம். உங்கள் முந்தைய அறிக்கைகளையும் மருந்துப் பட்டியலையும் எடுத்து வாருங்கள், 1 மணி நேரம் முன்னதாக வாருங்கள். அன்று காலை எந்த மருந்துகளை எடுக்க வேண்டும் என்று வார்டு செவிலியரிடம் கேளுங்கள்.';

/** Approved starting texts. The Tamil is plain, everyday wording, marked "to be checked" by staff (`taChecked: false`). */
export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    key: 'admitted',
    trigger: 'admitted',
    en: '{patient} has been admitted to {ward} ({bed}, {floor}). Visiting hours: {visiting}. The doctor will explain the plan of care. – {hospital}',
    ta: '{patient} அவர்கள் {ward} பிரிவில் அனுமதிக்கப்பட்டுள்ளார் ({bed}, {floor}). பார்வையாளர் நேரம்: {visiting}. சிகிச்சைத் திட்டத்தை மருத்துவர் விளக்குவார். – {hospital}'
  },
  {
    key: 'transferred',
    trigger: 'transferred',
    en: '{patient} has moved to {ward} ({bed}, {floor}). Visiting hours: {visiting}. – {hospital}',
    ta: '{patient} அவர்கள் {ward} பிரிவுக்கு மாற்றப்பட்டுள்ளார் ({bed}, {floor}). பார்வையாளர் நேரம்: {visiting}. – {hospital}'
  },
  {
    key: 'procedure-booked',
    trigger: 'procedure-booked',
    en: "{patient}'s {procedure} is booked for {date} at {time}. {instructions} – {hospital}",
    ta: '{patient} அவர்களின் {procedure} {date} அன்று {time} மணிக்கு ஏற்பாடு செய்யப்பட்டுள்ளது. {instructions} – {hospital}'
  },
  {
    key: 'procedure-reminder',
    trigger: 'procedure-reminder',
    en: "Reminder: {patient}'s {procedure} is tomorrow, {date}, at {time}. {instructions} – {hospital}",
    ta: 'நினைவூட்டல்: {patient} அவர்களின் {procedure} நாளை, {date} அன்று, {time} மணிக்கு. {instructions} – {hospital}'
  },
  {
    key: 'procedure-done',
    trigger: 'procedure-done',
    en: "{patient}'s {procedure} is over. The doctor will meet you to explain. – {hospital}",
    ta: '{patient} அவர்களின் {procedure} முடிந்தது. மருத்துவர் உங்களைச் சந்தித்து விளக்குவார். – {hospital}'
  },
  {
    key: 'estimate-ready',
    trigger: 'estimate-ready',
    en: "An estimate for {patient}'s treatment is ready. Please meet the billing desk, who will explain it. – {hospital}",
    ta: '{patient} அவர்களின் சிகிச்சைக்கான மதிப்பீடு தயாராக உள்ளது. கட்டணப் பிரிவைச் சந்தியுங்கள், அவர்கள் விளக்குவார்கள். – {hospital}'
  },
  {
    key: 'bill-final',
    trigger: 'bill-final',
    en: "{patient}'s final bill is ready. Balance due: {amount}. Please see the billing desk. – {hospital}",
    ta: '{patient} அவர்களின் இறுதிக் கட்டணச் சீட்டு தயாராக உள்ளது. செலுத்த வேண்டிய தொகை: {amount}. கட்டணப் பிரிவைச் சந்தியுங்கள். – {hospital}'
  },
  {
    key: 'discharge-pack',
    trigger: 'discharge-pack',
    en: '{patient} has been discharged. Your printed discharge summary lists the medicines. Follow-up: {followUp}. Come back at once, or call 108, if you notice: {warningSigns} – {hospital}',
    ta: '{patient} அவர்கள் டிஸ்சார்ஜ் செய்யப்பட்டுள்ளார். மருந்துகள் அச்சிடப்பட்ட டிஸ்சார்ஜ் சுருக்கத்தில் உள்ளன. பின்தொடர்வு: {followUp}. இவற்றில் ஏதேனும் தெரிந்தால் உடனே திரும்பி வாருங்கள், அல்லது 108 ஐ அழைக்கவும்: {warningSigns} – {hospital}'
  },
  {
    key: 'followup-booked',
    trigger: 'followup-booked',
    en: 'Follow-up for {patient} is booked for {date} at {time} with {doctor}. – {hospital}',
    ta: '{patient} அவர்களின் பின்தொடர்வு பரிசோதனை {date} அன்று {time} மணிக்கு {doctor} அவர்களுடன் ஏற்பாடு செய்யப்பட்டுள்ளது. – {hospital}'
  },
  {
    key: 'followup-reminder',
    trigger: 'followup-reminder',
    en: "Reminder: {patient}'s follow-up is tomorrow, {date}, at {time} with {doctor}. – {hospital}",
    ta: 'நினைவூட்டல்: {patient} அவர்களின் பின்தொடர்வு பரிசோதனை நாளை, {date} அன்று, {time} மணிக்கு {doctor} அவர்களுடன். – {hospital}'
  },
  {
    key: 'signs:general',
    trigger: null,
    en: 'chest pain or breathlessness; fever above 101°F (38.3°C); bleeding, or a wound that is red, swollen or leaking; severe pain; vomiting that stops you keeping medicines down; fainting, confusion or new weakness of the face, arm or leg.',
    ta: 'நெஞ்சு வலி அல்லது மூச்சுத்திணறல்; 101°F (38.3°C) க்கு மேல் காய்ச்சல்; ரத்தப்போக்கு, அல்லது சிவந்து, வீங்கி அல்லது கசியும் காயம்; கடுமையான வலி; மருந்துகளை உள்ளே வைத்திருக்க முடியாத அளவு வாந்தி; மயக்கம், குழப்பம் அல்லது முகம், கை அல்லது காலில் புதிய பலவீனம்.'
  },
  {
    key: 'signs:cardiac',
    trigger: null,
    en: 'chest pain, pressure or tightness; breathlessness at rest or when lying down; fainting or a racing heartbeat; bleeding that will not stop; sudden weakness of the face, arm or leg.',
    ta: 'நெஞ்சு வலி, அழுத்தம் அல்லது இறுக்கம்; ஓய்விலோ படுத்திருக்கும்போதோ மூச்சுத்திணறல்; மயக்கம் அல்லது வேகமான இதயத் துடிப்பு; நிற்காத ரத்தப்போக்கு; முகம், கை அல்லது காலில் திடீர் பலவீனம்.'
  },
  { key: 'prep:coronary-angiography', trigger: null, en: ANGIO_EN, ta: ANGIO_TA },
  {
    key: 'prep:coronary-angioplasty',
    trigger: null,
    en: `${ANGIO_EN} Plan to stay in hospital at least one night.`,
    ta: `${ANGIO_TA} குறைந்தது ஒரு இரவாவது மருத்துவமனையில் தங்க வேண்டியிருக்கும்.`
  },
  {
    key: 'prep:upper-gi-endoscopy',
    trigger: null,
    en: 'Please do not eat or drink for 8 hours before. Bring your earlier reports, and come with someone who can take you home. Ask the ward nurse which of your medicines to take that morning.',
    ta: 'தயவுசெய்து 8 மணி நேரத்துக்கு முன்பிருந்து எதுவும் சாப்பிடவோ குடிக்கவோ வேண்டாம். உங்கள் முந்தைய அறிக்கைகளை எடுத்து வாருங்கள், உங்களை வீட்டுக்கு அழைத்துச் செல்ல ஒருவருடன் வாருங்கள். அன்று காலை எந்த மருந்துகளை எடுக்க வேண்டும் என்று வார்டு செவிலியரிடம் கேளுங்கள்.'
  },
  {
    key: 'prep:ct-abdomen-contrast',
    trigger: null,
    en: 'Please do not eat for 4 hours before; you may drink water. Bring your earlier reports and your kidney test result if you have one. Ask the ward nurse which of your medicines to take that morning.',
    ta: 'தயவுசெய்து 4 மணி நேரத்துக்கு முன்பிருந்து சாப்பிட வேண்டாம்; தண்ணீர் குடிக்கலாம். உங்கள் முந்தைய அறிக்கைகளையும், சிறுநீரகப் பரிசோதனை முடிவு இருந்தால் அதையும் எடுத்து வாருங்கள். அன்று காலை எந்த மருந்துகளை எடுக்க வேண்டும் என்று வார்டு செவிலியரிடம் கேளுங்கள்.'
  },
  {
    key: 'emergency-line',
    trigger: null,
    en: 'Please come to the ER now, or call 108 for an ambulance.',
    ta: 'தயவுசெய்து உடனே அவசர சிகிச்சைப் பிரிவுக்கு வாருங்கள், அல்லது ஆம்புலன்சுக்கு 108 ஐ அழைக்கவும்.'
  }
];

/** Hospital facts the call agent may read out. May use {visiting}, {hospital}, {hospitalPhone} and {address}. To be checked by St. Mary's (Q42). */
export const DEFAULT_FAQS: DefaultFaq[] = [
  {
    topic: 'visiting-hours',
    title: 'Visiting hours',
    keywords: ['visit', 'visiting', 'visitor'],
    en: "Visiting hours are {visiting}. Two visitors per patient at a time; children under 12 only with a nurse's permission.",
    ta: 'பார்வையாளர் நேரம் {visiting}. ஒரே நேரத்தில் ஒரு நோயாளிக்கு இரண்டு பேர் மட்டுமே; 12 வயதுக்குட்பட்ட குழந்தைகள் செவிலியரின் அனுமதியுடன் மட்டுமே.'
  },
  {
    topic: 'directions',
    title: 'Directions',
    keywords: ['address', 'where', 'location', 'reach', 'route'],
    en: '{hospital} is at {address}. Ask at the main reception for the ward.',
    ta: '{hospital} {address} முகவரியில் உள்ளது. வார்டுக்கான வழியை முதன்மை வரவேற்பில் கேளுங்கள்.'
  },
  {
    topic: 'parking',
    title: 'Parking',
    keywords: ['parking', 'car', 'bike'],
    en: 'Parking is free inside the main gate. Ambulances use the ER entrance; please keep it clear.',
    ta: 'முதன்மை வாயிலுக்குள் வாகன நிறுத்தம் இலவசம். ஆம்புலன்ஸ்கள் அவசர சிகிச்சைப் பிரிவு நுழைவாயிலைப் பயன்படுத்தும்; அதைத் தடையின்றி வைத்திருங்கள்.'
  },
  {
    topic: 'reports',
    title: 'Lab reports',
    keywords: ['report', 'result', 'collect'],
    en: "Lab reports can be collected at the lab counter, ground floor, 8 AM to 8 PM. Bring the bill or the patient's card.",
    ta: 'ஆய்வக அறிக்கைகளை தரைத்தளத்தில் உள்ள ஆய்வகக் கவுண்டரில் காலை 8 மணி முதல் இரவு 8 மணி வரை பெறலாம். கட்டணச் சீட்டு அல்லது நோயாளியின் அட்டையை எடுத்து வாருங்கள்.'
  },
  {
    topic: 'billing-desk',
    title: 'Billing desk',
    keywords: ['bill', 'billing', 'pay', 'payment', 'insurance'],
    en: 'The billing desk is on the ground floor, open 8 AM to 9 PM. For the bill of a patient in the ward, ask for the running bill.',
    ta: 'கட்டணப் பிரிவு தரைத்தளத்தில் உள்ளது, காலை 8 மணி முதல் இரவு 9 மணி வரை திறந்திருக்கும். வார்டில் உள்ள நோயாளியின் கட்டணத்துக்கு, நடப்புக் கட்டணச் சீட்டைக் கேளுங்கள்.'
  },
  {
    topic: 'opd-timings',
    title: 'OPD timings',
    keywords: ['opd', 'doctor', 'timing', 'appointment', 'clinic'],
    en: 'The out-patient clinics run 9 AM to 1 PM and 4 PM to 7 PM, Monday to Saturday. Book by phone or at the reception.',
    ta: 'புறநோயாளிகள் மருத்துவமனை திங்கள் முதல் சனி வரை காலை 9 மணி முதல் 1 மணி வரையும், மாலை 4 மணி முதல் 7 மணி வரையும் இயங்கும். தொலைபேசியிலோ வரவேற்பிலோ முன்பதிவு செய்யலாம்.'
  },
  {
    topic: 'emergency',
    title: 'Emergency',
    keywords: ['emergency', 'er', 'casualty', 'ambulance', '108'],
    en: "The ER is open 24 hours. In an emergency, come to the ER at once or call 108 for an ambulance. The hospital's number is {hospitalPhone}.",
    ta: 'அவசர சிகிச்சைப் பிரிவு 24 மணி நேரமும் திறந்திருக்கும். அவசரத்தில் உடனே அவசர சிகிச்சைப் பிரிவுக்கு வாருங்கள், அல்லது ஆம்புலன்சுக்கு 108 ஐ அழைக்கவும். மருத்துவமனையின் எண் {hospitalPhone}.'
  },
  {
    topic: 'admission-items',
    title: 'What to bring for admission',
    keywords: ['admission', 'bring', 'admit'],
    en: "For admission, bring the patient's card or ID, earlier reports, the medicine list and the medicines, and clothes for a few days.",
    ta: 'அனுமதிக்கு, நோயாளியின் அட்டை அல்லது அடையாள அட்டை, முந்தைய அறிக்கைகள், மருந்துப் பட்டியல், மருந்துகள், மற்றும் சில நாட்களுக்கான உடைகளை எடுத்து வாருங்கள்.'
  },
  {
    topic: 'pharmacy-hours',
    title: 'Pharmacy hours',
    keywords: ['pharmacy', 'medicine', 'medicines', 'chemist'],
    en: 'The pharmacy is open 24 hours, next to the ER.',
    ta: 'மருந்தகம் 24 மணி நேரமும் திறந்திருக்கும், அவசர சிகிச்சைப் பிரிவுக்கு அருகில் உள்ளது.'
  },
  {
    topic: 'canteen',
    title: 'Canteen',
    keywords: ['canteen', 'food', 'cafe', 'meals'],
    en: 'The canteen is on the ground floor, open 6 AM to 10 PM.',
    ta: 'உணவகம் தரைத்தளத்தில் உள்ளது, காலை 6 மணி முதல் இரவு 10 மணி வரை திறந்திருக்கும்.'
  }
];
