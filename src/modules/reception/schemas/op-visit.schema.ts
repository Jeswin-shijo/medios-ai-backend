import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OpVisitDocument = OpVisit & Document;

export const VISIT_STATUSES = ['awaiting-payment', 'paid', 'cancelled', 'expired'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const PAYMENT_METHODS = ['UPI', 'CASH', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** One line of what happened to a visit, and who did it. */
@Schema({ _id: false })
export class VisitEvent {
  @Prop({ required: true })
  at: Date;

  @Prop({ required: true })
  event: string;

  @Prop({ default: '' })
  by: string;
}
export const VisitEventSchema = SchemaFactory.createForClass(VisitEvent);

/**
 * A patient's outpatient visit booked at the reception kiosk: the doctor and fee
 * chosen, then the payment. Paying gives it an OP number, a token and a paid bill.
 */
@Schema({ timestamps: true })
export class OpVisit {
  /** The clinic day the visit was booked, YYYY-MM-DD. */
  @Prop({ required: true })
  date: string;

  @Prop({ required: true })
  uhid: string;

  @Prop({ required: true })
  patientName: string;

  @Prop({ required: true })
  doctorId: string;

  @Prop({ required: true })
  doctorName: string;

  /** The department's name, as shown. */
  @Prop({ default: '' })
  department: string;

  @Prop({ default: '' })
  departmentCode: string;

  @Prop({ default: '' })
  room: string;

  /** Whole rupees, copied from the doctor when the visit was made. */
  @Prop({ required: true })
  fee: number;

  @Prop({ type: String, required: true, enum: VISIT_STATUSES, default: 'awaiting-payment' })
  status: VisitStatus;

  @Prop({ type: String, enum: PAYMENT_METHODS })
  method?: PaymentMethod;

  /** Who takes the payment: the payment provider's name ('sample'), 'cash' at the counter, or 'none'. */
  @Prop({ required: true })
  provider: string;

  @Prop()
  orderId?: string;

  @Prop()
  upiUri?: string;

  /** Four digits the patient shows at the counter to pay cash. */
  @Prop()
  paymentCode?: string;

  @Prop()
  transactionId?: string;

  @Prop()
  paidAt?: Date;

  @Prop()
  confirmedBy?: string;

  @Prop({ unique: true, sparse: true })
  opNumber?: string;

  @Prop()
  tokenId?: string;

  @Prop()
  tokenLabel?: string;

  @Prop()
  billId?: string;

  @Prop()
  billNumber?: string;

  /**
   * While set and in the future, a request is giving this paid visit its OP number,
   * token and bill; other requests wait for it rather than doing the same work.
   */
  @Prop()
  finishingUntil?: Date;

  @Prop({ required: true })
  kioskId: string;

  @Prop({ required: true })
  kioskName: string;

  /** How the patient was identified: card, otp or register. */
  @Prop({ required: true })
  via: string;

  /** An unpaid visit expires at this moment. */
  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: [VisitEventSchema], default: [] })
  history: VisitEvent[];
}

export const OpVisitSchema = SchemaFactory.createForClass(OpVisit);
OpVisitSchema.index({ date: 1, status: 1, createdAt: -1 });
OpVisitSchema.index({ status: 1, expiresAt: 1 });
