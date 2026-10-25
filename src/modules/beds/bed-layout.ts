import { Feature, WardInfo } from './bed-types';

export interface WardSeed extends Omit<WardInfo, 'id'> {
  sortOrder: number;
}

export interface BedSeed {
  wardCode: string;
  number: number;
  label: string;
  room?: string;
  features: Feature[];
  state: 'free' | 'occupied' | 'cleaning' | 'blocked';
  blockedReason?: string;
  occupantGender?: 'Male' | 'Female';
  namedPatientUhid?: string;
  sample: boolean;
}

interface LayoutWard extends Omit<WardSeed, 'sortOrder'> {
  beds: number;
  features: (n: number) => Feature[];
  label?: (n: number, room?: string) => string;
  room?: (n: number) => string;
  free?: number[];
  cleaning?: number[];
  blocked?: Record<number, string>;
  occupantGender?: (n: number) => 'Male' | 'Female';
}

const all = (...f: Feature[]) => () => f;
const generalFeatures = (n: number): Feature[] => [
  ...(n <= 10 ? (['oxygen'] as Feature[]) : []),
  ...(n <= 6 ? (['nearNurses'] as Feature[]) : []),
];
const generalDepartments = ['General Medicine', 'General Surgery', 'Nephrology', 'Endocrinology', 'Neurology'];

const BED_LAYOUT: LayoutWard[] = [
  {
    code: 'ER', name: 'Emergency observation', shortName: 'Emergency', floor: 0, type: 'emergency', gender: 'any',
    ratePerDay: 1000, nearDepartments: ['Emergency & Trauma Care', 'Emergency & Critical Care'],
    beds: 6, features: all('oxygen'), free: [2, 5],
  },
  {
    code: 'ICU', name: 'ICU', shortName: 'ICU', floor: 0, type: 'icu', gender: 'any',
    ratePerDay: 7500, nearDepartments: ['Emergency & Critical Care', 'Cardiology'],
    beds: 8, features: (n) => ['monitor', 'oxygen', 'nearNurses', ...(n <= 3 ? (['ventilator'] as Feature[]) : [])],
    free: [4], cleaning: [6],
  },
  {
    code: 'HDU', name: 'HDU (step-down)', shortName: 'HDU', floor: 0, type: 'hdu', gender: 'any',
    ratePerDay: 4000, nearDepartments: ['Cardiology', 'Emergency & Critical Care', 'Pulmonology'],
    beds: 6, features: all('monitor', 'oxygen', 'nearNurses'), free: [2, 4],
  },
  {
    code: 'ISO', name: 'Isolation rooms', shortName: 'Isolation', floor: 0, type: 'isolation', gender: 'any',
    ratePerDay: 2000, nearDepartments: ['Pulmonology'],
    beds: 4, features: all('singleRoom', 'oxygen'), label: (n) => `Isolation • Room ${n}`, free: [1, 3],
  },
  {
    code: 'GWA', name: 'General ward A (men)', shortName: 'Ward A', floor: 1, type: 'general', gender: 'male',
    ratePerDay: 800, nearDepartments: generalDepartments,
    beds: 30, features: generalFeatures, free: [4, 8, 15, 20, 23, 27], cleaning: [9],
    blocked: { 17: 'Repairs: oxygen point' }, occupantGender: () => 'Male',
  },
  {
    code: 'GWB', name: 'General ward B (women)', shortName: 'Ward B', floor: 1, type: 'general', gender: 'female',
    ratePerDay: 800, nearDepartments: generalDepartments,
    beds: 30, features: generalFeatures, free: [3, 10, 14, 19, 25, 28], cleaning: [7, 22],
    occupantGender: () => 'Female',
  },
  {
    code: 'PED', name: 'Paediatric ward', shortName: 'Paediatric', floor: 1, type: 'paediatric', gender: 'any',
    ratePerDay: 900, nearDepartments: ['Pediatrics'],
    beds: 12, features: (n) => ['attendantBed', ...(n <= 4 ? (['nearNurses'] as Feature[]) : [])], free: [2, 6, 9, 11],
  },
  {
    code: 'MAT', name: 'Maternity ward', shortName: 'Maternity', floor: 2, type: 'maternity', gender: 'female',
    ratePerDay: 1200, nearDepartments: ['Obstetrics'],
    beds: 12, features: (n) => (n <= 4 ? ['nearNurses'] : []), free: [1, 5, 8], occupantGender: () => 'Female',
  },
  {
    code: 'TWN', name: 'Twin-sharing rooms', shortName: 'Twin', floor: 2, type: 'twin', gender: 'any',
    ratePerDay: 1500, nearDepartments: ['General Medicine'],
    beds: 16, features: () => [], room: (n) => String(Math.ceil(n / 2)),
    label: (n, room) => `Twin ${room} • Bed ${n % 2 ? 'A' : 'B'}`, free: [2, 7, 12],
    occupantGender: (n) => (Math.ceil(n / 2) % 2 ? 'Male' : 'Female'),
  },
  {
    code: 'PVT', name: 'Private rooms', shortName: 'Private', floor: 2, type: 'private', gender: 'any',
    ratePerDay: 2500, nearDepartments: ['General Medicine', 'General Surgery'],
    beds: 10, features: all('singleRoom', 'attendantBed'), label: (n) => `Private • Room ${n}`,
    free: [3, 8], cleaning: [5],
  },
  {
    code: 'DLX', name: 'Deluxe suites', shortName: 'Deluxe', floor: 2, type: 'deluxe', gender: 'any',
    ratePerDay: 4000, nearDepartments: ['General Medicine'],
    beds: 4, features: all('singleRoom', 'attendantBed'), label: (n) => `Deluxe • Suite ${n}`, free: [2],
  },
];

const NAMED_PATIENTS: Record<string, string> = {
  'GWA-12': 'MHK202500325', // David Raj
  'HDU-1': 'MHK202500327', // James Wilson
};

export function buildBedSeed(): { wards: WardSeed[]; beds: BedSeed[] } {
  const wards: WardSeed[] = [];
  const beds: BedSeed[] = [];

  BED_LAYOUT.forEach((w, index) => {
    const { beds: count, features, label, room, free, cleaning, blocked, occupantGender, ...ward } = w;
    wards.push({ ...ward, sortOrder: index });

    for (let n = 1; n <= count; n++) {
      const roomName = room?.(n);
      const state: BedSeed['state'] = free?.includes(n)
        ? 'free'
        : cleaning?.includes(n)
          ? 'cleaning'
          : blocked?.[n]
            ? 'blocked'
            : 'occupied';
      const namedPatientUhid = NAMED_PATIENTS[`${w.code}-${n}`];
      const bed: BedSeed = {
        wardCode: w.code,
        number: n,
        label: label ? label(n, roomName) : `${w.shortName} • Bed ${n}`,
        features: features(n),
        state,
        sample: state === 'occupied' && !namedPatientUhid,
      };
      if (roomName) bed.room = roomName;
      if (state === 'blocked') bed.blockedReason = blocked![n];
      if (state === 'occupied') {
        bed.occupantGender = namedPatientUhid ? 'Male' : occupantGender ? occupantGender(n) : n % 2 ? 'Male' : 'Female';
        if (namedPatientUhid) bed.namedPatientUhid = namedPatientUhid;
      }
      beds.push(bed);
    }
  });

  return { wards, beds };
}
