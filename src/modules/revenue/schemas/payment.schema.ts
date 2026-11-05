import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { ActorRef, ActorRefSchema } from './actor-ref';

export type PaymentDocument = Payment & Document;

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'kiosk'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_KINDS = ['deposit', 'part', 'settlement'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

@Schema({ _id: false })
export class PaymentCancelled {
  @Prop({ type: Date, required: true }) at: Date;
  @Prop({ type: ActorRefSchema, required: true }) by: ActorRef;
  @Prop({ required: true }) reason: string;
}
export const PaymentCancelledSchema = SchemaFactory.createForClass(PaymentCancelled);

@Schema({ timestamps: true })
export class Payment {
  @Prop({ required: true, unique: true })
  receiptNumber: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  bill: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  amount: number;

  @Prop({ type: String, required: true, enum: PAYMENT_MODES })
  mode: PaymentMode;

  @Prop({ default: '' })
  reference: string;

  /** The record the money came from, one payment each: `op-visit:<id>` for a payment taken at the reception kiosk. */
  @Prop({ type: String })
  source?: string;

  @Prop({ type: String, required: true, enum: PAYMENT_KINDS })
  kind: PaymentKind;

  @Prop({ type: ActorRefSchema, required: true })
  by: ActorRef;

  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ type: PaymentCancelledSchema })
  cancelled?: PaymentCancelled;

  @Prop({ type: Date })
  announcedAt?: Date;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);
// A kiosk visit is paid once, whatever retries or replays bring it back.
PaymentSchema.index({ source: 1 }, { unique: true, partialFilterExpression: { source: { $type: 'string' } } });
