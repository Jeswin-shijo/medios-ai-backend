import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import type { WardType } from '../../beds/bed-types';

export type BillDocument = Bill & Document;

export const BILL_KINDS = ['opd', 'er', 'admission', 'walk-in'] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export const BILL_STATES = ['open', 'final', 'settled'] as const;
export type BillState = (typeof BILL_STATES)[number];
/** A bill is active while charges can still land on it. */
export const ACTIVE_BILL_STATES: BillState[] = ['open', 'final'];

/** All whole rupees. balance = charges - discounts - payments + refunds. */
@Schema({ _id: false })
export class BillTotals {
  @Prop({ default: 0 }) charges: number;
  @Prop({ default: 0 }) discounts: number;
  @Prop({ default: 0 }) payments: number;
  @Prop({ default: 0 }) refunds: number;
  @Prop({ default: 0 }) balance: number;
}
export const BillTotalsSchema = SchemaFactory.createForClass(BillTotals);

@Schema({ timestamps: true })
export class Bill {
  @Prop({ required: true, unique: true })
  number: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  patient: Types.ObjectId;

  @Prop({ required: true })
  patientUhid: string;

  @Prop({ required: true })
  patientName: string;

  @Prop({ type: String, required: true, enum: BILL_KINDS })
  kind: BillKind;

  @Prop({ type: String, required: true, enum: BILL_STATES, default: 'open' })
  state: BillState;

  @Prop({ type: MongooseSchema.Types.ObjectId, index: true })
  case?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  erVisit?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  admission?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  appointment?: Types.ObjectId;

  /** The clinic day (YYYY-MM-DD) for opd and walk-in bills. */
  @Prop()
  day?: string;

  @Prop({ type: String })
  wardType?: WardType;

  @Prop({ type: String, default: 'self' })
  payer: 'self';

  @Prop({ type: Date, required: true })
  openedAt: Date;

  @Prop({ type: Date })
  finalAt?: Date;

  @Prop({ type: Date })
  settledAt?: Date;

  @Prop({ type: BillTotalsSchema, default: () => ({}) })
  totals: BillTotals;

  /**
   * Set once the Coordinator message for the bill's current state is sent (final-requested while open with the `:final` task,
   * bill-final, bill-settled). Every state change unsets it (R23); the reconcile pass re-sends when it is missing.
   */
  @Prop({ type: Date })
  announcedAt?: Date;

  /** The advance last asked for. announcedAt is set once `revenue.deposit-due` is sent; the reconcile pass re-sends when it is missing. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  depositAsk?: { amount: number; announcedAt?: Date };

  /** The top-up last asked for, and (metAt) when it was met. Each has its own announcedAt; the reconcile pass re-sends the missing ones. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  topupAsk?: { amount?: number; dueAt?: Date; announcedAt?: Date; metAt?: Date; metAnnouncedAt?: Date };
}

export const BillSchema = SchemaFactory.createForClass(Bill);

const ACTIVE = { state: { $in: ACTIVE_BILL_STATES } };
BillSchema.index(
  { appointment: 1 },
  { unique: true, partialFilterExpression: { kind: 'opd', appointment: { $exists: true }, ...ACTIVE } },
);
BillSchema.index(
  { patient: 1, day: 1 },
  { unique: true, partialFilterExpression: { kind: 'walk-in', day: { $exists: true }, ...ACTIVE } },
);
BillSchema.index({ erVisit: 1 }, { unique: true, partialFilterExpression: { kind: 'er', erVisit: { $exists: true }, ...ACTIVE } });
BillSchema.index({ admission: 1 }, { unique: true, partialFilterExpression: { kind: 'admission', admission: { $exists: true }, ...ACTIVE } });
BillSchema.index({ state: 1, openedAt: -1 });
