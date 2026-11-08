// Pure builders for the demo outpatient departments and doctors (no database access).

export interface SeedDepartment {
  code: string;
  name: string;
  tokenPrefix: string;
  icon: string;
  color: string;
  order: number;
  active: boolean;
}

export interface SeedDoctor {
  name: string;
  qualifications: string;
  departmentCode: string;
  fee: number;
  room: string;
  tokenPrefix: string;
  sessions: { days: number[]; start: string; end: string }[];
  avgConsultMinutes: number;
  active: boolean;
}

/**
 * The reception kiosk's demo cards, for patients not checked in yet, so the kiosk can be tried without real cards
 * (seed.ts links them). The Discharge seed keeps these patients out of its inpatient stories (David Raj is its own story).
 */
export const DEMO_CARDS: readonly { cardId: string; uhid: string }[] = [
  { cardId: '04A1B2C3', uhid: 'MHK202500324' }, // Rekha S
  { cardId: '0004567890', uhid: 'MHK202500325' }, // David Raj
  { cardId: '04C8D9E0F1A2B3', uhid: 'MHK202500326' }, // Selvi A
];

export function buildDepartments(): SeedDepartment[] {
  const rows: [string, string, string, string, string][] = [
    ['gen-med', 'General Medicine', 'G', 'medical-services', '#1E6BFF'],
    ['pediatrics', 'Pediatrics', 'P', 'child-care', '#EC4899'],
    ['cardiology', 'Cardiology', 'C', 'favorite', '#EF4444'],
    ['orthopedics', 'Orthopedics', 'O', 'accessibility', '#8B5CF6'],
    ['gynecology', 'Gynecology', 'Y', 'pregnant-woman', '#F43F5E'],
    ['dermatology', 'Dermatology', 'D', 'healing', '#F59E0B'],
  ];
  return rows.map(([code, name, tokenPrefix, icon, color], order) => ({ code, name, tokenPrefix, icon, color, order, active: true }));
}

const MON_SAT = [1, 2, 3, 4, 5, 6];
const GEN_MED_HOURS: [string, string][] = [['08:00', '14:00'], ['16:00', '22:00']];
const OTHER_HOURS: [string, string][] = [['09:00', '13:00'], ['17:00', '21:00']];

export function buildDoctors(departments: SeedDepartment[]): SeedDoctor[] {
  const known = new Set(departments.map((d) => d.code));
  // name, qualifications, department, fee, room, token letters, hours
  const rows: [string, string, string, number, string, string, [string, string][]][] = [
    ['Dr. Shajin', 'MBBS, MD (Internal Medicine)', 'gen-med', 300, 'Room 101', 'G', GEN_MED_HOURS],
    ['Dr. Arun Kumar', 'MBBS, MD', 'gen-med', 300, 'Room 102', 'G2', GEN_MED_HOURS],
    ['Dr. Priya Fernandez', 'MBBS, DNB', 'gen-med', 300, 'Room 103', 'G3', GEN_MED_HOURS],
    ['Dr. Meena Joseph', 'MBBS, DCH, MD', 'pediatrics', 350, 'Room 201', 'P', OTHER_HOURS],
    ['Dr. Rajesh Pillai', 'MBBS, MD, DM (Cardiology)', 'cardiology', 600, 'Room 305', 'C', OTHER_HOURS],
    ['Dr. John Varghese', 'MBBS, MS (Ortho)', 'orthopedics', 400, 'Room 108', 'O', OTHER_HOURS],
    ['Dr. Lakshmi Narayanan', 'MBBS, DGO', 'gynecology', 450, 'Room 210', 'Y', OTHER_HOURS],
    // Evenings only, so the kiosk shows "From 5:00 PM" in the morning.
    ['Dr. Suresh Nair', 'MBBS, DDVL', 'dermatology', 400, 'Room 112', 'D', [OTHER_HOURS[1]]],
  ];
  return rows.map(([name, qualifications, departmentCode, fee, room, tokenPrefix, hours]) => {
    if (!known.has(departmentCode)) throw new Error(`Unknown department ${departmentCode}`);
    return {
      name,
      qualifications,
      departmentCode,
      fee,
      room,
      tokenPrefix,
      sessions: hours.map(([start, end]) => ({ days: MON_SAT, start, end })),
      avgConsultMinutes: 10,
      active: true,
    };
  });
}

/** The queue's rooms: every doctor's room, then the shared Consultation Room. */
export function buildCounters(doctors: SeedDoctor[]): string[] {
  return [...doctors.map((d) => d.room), 'Consultation Room'];
}
