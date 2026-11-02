import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { ActorRef, ActorRefSchema } from './actor-ref';
import type { PaymentMode } from './payment.schema';

export type RefundDocument = Refund & Document;

export const REFUND_STATES = ['requested', 'approved', 'paid', 'rejected'] as const;
export type RefundState = (typeof REFUND_STATES)[number];

@Schema({ _id: false })
export class RefundPaid {
  @Prop({ type: Date, required: true }) at: Date;
  @Prop({ type: ActorRefSchema, required: true }) by: ActorRef;
  @Prop({ type: String, required: true }) mode: PaymentMode;
  @Prop({ default: '' }) reference: string;
}
export const RefundPaidSchema = SchemaFactory.createForClass(RefundPaid);

@Schema({ timestamps: true })
export class Refund {
  @Prop({ required: true, unique: true })
  number: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  bill: Types.ObjectId;

  @Prop({ required: true, min: 1 })
  amount: number;

  @Prop({ type: String, required: true, enum: REFUND_STATES, default: 'requested' })
  state: RefundState;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  approvalId?: Types.ObjectId;

  @Prop({ type: RefundPaidSchema })
  paid?: RefundPaid;

  @Prop({ type: Date })
  dueAt?: Date;

  @Prop({ type: Date })
  announcedAt?: Date;
}

export const RefundSchema = SchemaFactory.createForClass(Refund);
