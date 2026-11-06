import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { ActorRef, ActorRefSchema } from '../../revenue/schemas/actor-ref';
import { COMPLETION_KINDS, CompletionKind } from '../discharge-catalogue';

export type DischargePlanDocument = DischargePlan & Document;

export const PLAN_STATES = ['planned', 'ordered', 'ready', 'completed'] as const;
export type PlanState = (typeof PLAN_STATES)[number];

/** One change of the target date, by a doctor or an admin. */
@Schema({ _id: false })
export class TargetChange {
  /** The target days, YYYY-MM-DD. */
  @Prop({ required: true }) from: string;
  @Prop({ required: true }) to: string;
  @Prop({ type: ActorRefSchema, required: true }) by: ActorRef;
  /** Clinic clock. */
  @Prop({ type: Date, required: true }) at: Date;
  @Prop() note?: string;
}
export const TargetChangeSchema = SchemaFactory.createForClass(TargetChange);

/** A patient who had already gone, as a nurse or an admin recorded it. The reason stays here, never in a message. */
@Schema({ _id: false })
export class LeftWithoutDischargeRecord {
  /** 1 to 300 characters. */
  @Prop({ required: true }) reason: string;
  /** Clinic clock: when the patient was last seen; the stay (and its bed days) ends here. */
  @Prop({ type: Date, required: true }) lastSeenAt: Date;
  @Prop({ type: ActorRefSchema, required: true }) by: ActorRef;
  /** Clinic clock: when it was recorded. */
  @Prop({ type: Date, required: true }) at: Date;
  /** Real time `discharge.completed` went, for a stay with no order (an order records it in its own `announced`). */
  @Prop({ type: Date }) announcedAt?: Date;
}
export const LeftWithoutDischargeRecordSchema = SchemaFactory.createForClass(LeftWithoutDischargeRecord);

/** One per real admission, opened at bed assignment and completed when the patient leaves. */
@Schema({ timestamps: true })
export class DischargePlan {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  admission: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  case?: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  patient: Types.ObjectId;

  @Prop({ required: true })
  patientUhid: string;

  @Prop({ required: true })
  patientName: string;

  /** The bed now; a transfer between beds updates it. */
  @Prop({ required: true })
  bedLabel: string;

  @Prop({ required: true })
  wardName: string;

  /** The admission's doctor, as its free text. */
  @Prop({ default: '' })
  doctor: string;

  /** The target clinic day, YYYY-MM-DD. */
  @Prop({ required: true })
  targetDay: string;

  /** Clinic clock: admission + expected stay at first, then the target day at 11:00 after a change. */
  @Prop({ type: Date, required: true })
  targetAt: Date;

  @Prop({ type: [TargetChangeSchema], default: [] })
  targetLog: TargetChange[];

  @Prop({ type: String, required: true, enum: PLAN_STATES, default: 'planned' })
  state: PlanState;

  /** The active order. */
  @Prop({ type: MongooseSchema.Types.ObjectId })
  order?: Types.ObjectId;

  /** The target day the morning reminder was raised for. */
  @Prop()
  remindedDay?: string;

  /** Real time `discharge.planned` was sent for the current target; the one-minute pass re-sends when it is missing. */
  @Prop({ type: Date })
  announcedAt?: Date;

  /** Clinic clock. */
  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ type: String, enum: COMPLETION_KINDS })
  completedKind?: CompletionKind;

  @Prop({ type: LeftWithoutDischargeRecordSchema })
  leftWithoutDischarge?: LeftWithoutDischargeRecord;
}

export const DischargePlanSchema = SchemaFactory.createForClass(DischargePlan);
// One plan per admission: a replayed bed.assigned turns into a read.
DischargePlanSchema.index({ admission: 1 }, { unique: true });
DischargePlanSchema.index({ state: 1, targetDay: 1 });
