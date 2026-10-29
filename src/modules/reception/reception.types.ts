/** The kiosk device making a request. */
export interface KioskRef {
  id: string;
  name: string;
}

export interface PatientSummary {
  uhid: string;
  name: string;
  age: number;
  gender: string;
  /** Masked (`••••• 43210`) unless the patient proved who they are with a code. */
  phone: string;
  lastVisit?: string;
  lastDepartment?: string;
  /** Only in full summaries. */
  address?: string;
}

export interface KioskTokenView {
  label: string;
  status: string;
  ahead: number;
  room: string;
  doctorName: string;
  department: string;
  trackCode: string;
  trackUrl: string;
  issuedAt: string;
  appointmentTime?: string;
}

export interface IdentifyResult {
  /** Opaque; sent back by the kiosk with later steps. */
  session: string;
  patient: PatientSummary;
  activeToken: KioskTokenView | null;
  appointmentToday: { time: string } | null;
}
