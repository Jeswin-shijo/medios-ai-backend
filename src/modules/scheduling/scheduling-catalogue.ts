// Rooms, procedures, staff skills and shifts (spec 5.3, 5.4, 4.2). Pure data.

export type RoomKind = 'cath-lab' | 'ot' | 'procedure' | 'xray' | 'ct' | 'ultrasound';

export interface RoomDef {
  key: string;
  name: string;
  kind: RoomKind;
  open: string;
  close: string;
  /** Minutes of clean-up between two procedures. */
  turnover: number;
}

export const ROOMS: RoomDef[] = [
  { key: 'cath-lab', name: 'Cath lab', kind: 'cath-lab', open: '08:00', close: '18:00', turnover: 15 },
  { key: 'ot-1', name: 'OT 1', kind: 'ot', open: '08:00', close: '20:00', turnover: 30 },
  { key: 'ot-2', name: 'OT 2', kind: 'ot', open: '08:00', close: '20:00', turnover: 30 },
  { key: 'procedure-room', name: 'Procedure room', kind: 'procedure', open: '09:00', close: '17:00', turnover: 10 },
  { key: 'xray', name: 'X-ray', kind: 'xray', open: '08:00', close: '20:00', turnover: 5 },
  { key: 'ct', name: 'CT', kind: 'ct', open: '08:00', close: '20:00', turnover: 10 },
  { key: 'ultrasound', name: 'Ultrasound', kind: 'ultrasound', open: '09:00', close: '17:00', turnover: 5 },
];

export type Skill =
  | 'physician' | 'cardiologist' | 'surgeon' | 'orthopaedic-surgeon' | 'obstetrician'
  | 'anaesthetist' | 'paediatrician' | 'ent-surgeon' | 'radiologist' | 'sonologist'
  | 'cath-nurse' | 'ot-nurse' | 'procedure-nurse' | 'ward-nurse' | 'cath-technician'
  | 'radiographer' | 'pharmacist' | 'lab-technician' | 'front-desk';

export const SKILL_LABEL: Record<Skill, string> = {
  physician: 'Physician',
  cardiologist: 'Cardiologist',
  surgeon: 'Surgeon',
  'orthopaedic-surgeon': 'Orthopaedic surgeon',
  obstetrician: 'Obstetrician',
  anaesthetist: 'Anaesthetist',
  paediatrician: 'Paediatrician',
  'ent-surgeon': 'ENT surgeon',
  radiologist: 'Radiologist',
  sonologist: 'Sonologist',
  'cath-nurse': 'Cath nurse',
  'ot-nurse': 'OT nurse',
  'procedure-nurse': 'Procedure nurse',
  'ward-nurse': 'Ward nurse',
  'cath-technician': 'Cath technician',
  radiographer: 'Radiographer',
  pharmacist: 'Pharmacist',
  'lab-technician': 'Lab technician',
  'front-desk': 'Front desk',
};

export const SKILLS = Object.keys(SKILL_LABEL) as Skill[];

export interface ProcedureDef {
  key: string;
  name: string;
  roomKind: RoomKind;
  minutes: number;
  team: Skill[];
  /** Lab test keys (see lab-catalogue). */
  preTests: string[];
  contrast: boolean;
}

export const PROCEDURES: ProcedureDef[] = [
  { key: 'coronary-angiography', name: 'Coronary angiography', roomKind: 'cath-lab', minutes: 45, team: ['cardiologist', 'cath-nurse', 'cath-technician'], preTests: ['rft', 'coag'], contrast: true },
  { key: 'coronary-angioplasty', name: 'Coronary angioplasty', roomKind: 'cath-lab', minutes: 90, team: ['cardiologist', 'cath-nurse', 'cath-technician'], preTests: ['rft', 'coag'], contrast: true },
  { key: 'lap-appendectomy', name: 'Laparoscopic appendectomy', roomKind: 'ot', minutes: 90, team: ['surgeon', 'anaesthetist', 'ot-nurse'], preTests: ['cbc', 'coag'], contrast: false },
  { key: 'hernia-repair', name: 'Hernia repair', roomKind: 'ot', minutes: 90, team: ['surgeon', 'anaesthetist', 'ot-nurse'], preTests: ['cbc', 'coag'], contrast: false },
  { key: 'caesarean-section', name: 'Caesarean section', roomKind: 'ot', minutes: 60, team: ['obstetrician', 'anaesthetist', 'ot-nurse'], preTests: ['cbc'], contrast: false },
  { key: 'fracture-fixation', name: 'Fracture fixation', roomKind: 'ot', minutes: 120, team: ['orthopaedic-surgeon', 'anaesthetist', 'ot-nurse'], preTests: ['cbc', 'coag'], contrast: false },
  { key: 'upper-gi-endoscopy', name: 'Upper GI endoscopy', roomKind: 'procedure', minutes: 30, team: ['physician', 'procedure-nurse'], preTests: [], contrast: false },
  { key: 'chest-xray', name: 'Chest X-ray', roomKind: 'xray', minutes: 10, team: ['radiographer'], preTests: [], contrast: false },
  { key: 'ct-head', name: 'CT head', roomKind: 'ct', minutes: 20, team: ['radiographer'], preTests: [], contrast: false },
  { key: 'ct-abdomen-contrast', name: 'CT abdomen (contrast)', roomKind: 'ct', minutes: 30, team: ['radiographer'], preTests: ['rft'], contrast: true },
  { key: 'ultrasound-abdomen', name: 'Ultrasound abdomen', roomKind: 'ultrasound', minutes: 20, team: ['sonologist'], preTests: [], contrast: false },
  { key: 'echocardiogram', name: 'Echocardiogram', roomKind: 'ultrasound', minutes: 30, team: ['cardiologist'], preTests: [], contrast: false },
];

export const procedureByKey = (key: string): ProcedureDef | undefined => PROCEDURES.find((p) => p.key === key);
export const roomByKey = (key: string): RoomDef | undefined => ROOMS.find((r) => r.key === key);

export type Shift = 'morning' | 'evening' | 'night' | 'on-call';

export const DEFAULT_SHIFTS: Record<Shift, { start: string; end: string }> = {
  morning: { start: '08:00', end: '14:00' },
  evening: { start: '14:00', end: '20:00' },
  night: { start: '20:00', end: '08:00' },
  'on-call': { start: '08:00', end: '08:00' },
};

export type Priority = 'stat' | 'urgent' | 'routine';

/** How far ahead (minutes) a request of this priority may be booked. */
export const WINDOW_MINUTES: Record<Priority, number> = { stat: 0, urgent: 1440, routine: 20160 };
export const LEAD_MINUTES = 30;
export const GRID_MINUTES = 15;

export const DEFAULT_CONSULT_TARGETS: Record<Priority, number> = { stat: 30, urgent: 120, routine: 1440 };
export const DEFAULT_WAIT_TARGETS = { stat: 15, urgent: 120 };
