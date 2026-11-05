import type { PaymentMethod, VisitStatus } from './schemas/op-visit.schema';

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

/** An OP visit as the kiosk and the staff desk see it. */
export interface VisitView {
  id: string;
  status: VisitStatus;
  method?: PaymentMethod;
  /** Whole rupees. */
  fee: number;
  /** Paid through the sample provider: screens must say SAMPLE. */
  sample: boolean;
  doctor: { id: string; name: string; department: string; room: string };
  patient: { name: string; uhid: string };
  /** Cash only: the four digits the patient shows at the counter. */
  paymentCode?: string;
  upiUri?: string;
  expiresAt: string;
  paidAt?: string;
  /** "26 Sep 2026, 10:24 AM", on the clinic day. */
  paidAtDisplay?: string;
  transactionId?: string;
  opNumber?: string;
  /** The Revenue bill (BL-…) the visit is on; OPB-… for a visit paid before the Revenue Agent billed the kiosk. */
  billNumber?: string;
  /** The Revenue receipt (RC-…) of the kiosk payment. */
  receiptNumber?: string;
  token?: KioskTokenView;
  kioskName: string;
  via: string;
  createdAt: string;
}
