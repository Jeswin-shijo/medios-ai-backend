import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type QueueTokenDocument = QueueToken & Document;

/**
 * waiting → called → completed; a called patient who does not come is skipped and
 * can be put back in the queue. Waiting or skipped tokens can be cancelled.
 */
export const TOKEN_STATUSES = ['waiting', 'called', 'skipped', 'completed', 'cancelled'] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

/** Statuses in which a patient still holds the token (one per patient per day). */
export const ACTIVE_TOKEN_STATUSES: TokenStatus[] = ['waiting', 'called', 'skipped'];

/** Who issued it: the front desk now; a card tap at a kiosk later. */
export const TOKEN_SOURCES = ['front-desk', 'kiosk'] as const;

/** A patient's place in the day's queue. */
@Schema({ timestamps: true })
export class QueueToken {
  /** The clinic day, YYYY-MM-DD. Numbers restart each day. */
  @Prop({ required: true, index: true })
  date: string;

  @Prop({ required: true })
  number: number;

  /** As shown and spoken: prefix + number, e.g. "A12". */
  @Prop({ required: true })
  label: string;

  @Prop({ default: 'waiting', enum: TOKEN_STATUSES })
  status: string;

  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  patientName: string;

  /** Today's appointment this visit fulfils; absent for a walk-in. */
  @Prop()
  appointmentId?: string;

  @Prop({ default: '' })
  appointmentTime: string;

  /** Served ahead of the others (elderly, pregnant, unwell). */
  @Prop({ default: false })
  priority: boolean;

  @Prop({ default: '' })
  note: string;

  @Prop({ default: 'front-desk', enum: TOKEN_SOURCES })
  source: string;

  @Prop({ default: '' })
  issuedBy: string;

  /** The room or counter it was called to. */
  @Prop()
  counter?: string;

  /** The latest call or recall; the display announces each change. */
  @Prop()
  calledAt?: Date;

  /** When the patient's wait ended. */
  @Prop()
  firstCalledAt?: Date;

  @Prop({ default: '' })
  calledBy: string;

  /** Times it was announced again. */
  @Prop({ default: 0 })
  recalls: number;

  @Prop()
  completedAt?: Date;

  /** Set while the token is active, cleared when it ends: one live token per patient per day. */
  @Prop()
  activeKey?: string;
}

export const QueueTokenSchema = SchemaFactory.createForClass(QueueToken);
QueueTokenSchema.index({ date: 1, number: 1 }, { unique: true });
QueueTokenSchema.index({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } });
// One called token per room: two "next" presses at once cannot both call someone.
QueueTokenSchema.index({ date: 1, counter: 1 }, { unique: true, partialFilterExpression: { status: { $eq: 'called' } } });
