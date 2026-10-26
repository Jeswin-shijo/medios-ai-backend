export type BedState = 'free' | 'held' | 'occupied' | 'cleaning' | 'blocked';
export type WardType =
  | 'emergency'
  | 'icu'
  | 'hdu'
  | 'isolation'
  | 'general'
  | 'paediatric'
  | 'maternity'
  | 'twin'
  | 'private'
  | 'deluxe';
export type RoomClass = Exclude<WardType, 'isolation'>;
export type Need = 'oxygen' | 'highFallRisk' | 'isolation' | 'ventilator' | 'monitor' | 'pregnant';
export const NEEDS: Need[] = ['oxygen', 'highFallRisk', 'isolation', 'ventilator', 'monitor', 'pregnant'];
export type GenderRule = 'male' | 'female' | 'any';
export type PatientGender = 'Male' | 'Female' | 'Other';
export type Feature = 'oxygen' | 'monitor' | 'ventilator' | 'nearNurses' | 'singleRoom' | 'attendantBed';

export interface WardInfo {
  id: string;
  code: string;
  name: string;
  shortName: string;
  floor: number;
  type: WardType;
  gender: GenderRule;
  ratePerDay: number;
  nearDepartments: string[];
}

export interface BedInfo {
  id: string;
  wardId: string;
  label: string;
  number: number;
  room?: string;
  features: Feature[];
  state: BedState;
  holdExpiresAt?: Date;
  /** The gender of the patient a held bed is for (the twin-room rule). */
  holdGender?: PatientGender;
  occupantGender?: PatientGender;
  freeSince?: Date;
}

export interface AdmissionRequestInput {
  age: number;
  gender: PatientGender;
  roomClass: RoomClass;
  needs: Need[];
  department: string;
  expectedStayDays: number;
  notes: string;
  currentBedId?: string;
}
