import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type InboundSessionDocument = InboundSession & Document;

/** A short code the agent quotes back ("A1", "S2") instead of a database id. */
@Schema({ _id: false })
export class SessionCode {
  @Prop({ required: true })
  code: string;

  /** Appointment codes: the appointment's id. */
  @Prop()
  appointmentId?: string;

  /** Slot codes: the slot. */
  @Prop()
  date?: string;

  @Prop()
  time?: string;

  @Prop()
  label?: string;
}

/**
 * One verified caller on an inbound call. find_patient creates it after the identity
 * check and hands the agent its `code` (the caller_ref); every later tool must quote
 * it, so actions are bound to the verified patient rather than to whatever the
 * language model passes. It is bound to the first call id it sees (or the caller's
 * number when there is none), lasts 20 minutes, and ends when the call is logged.
 */
@Schema({ timestamps: true })
export class InboundSession {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true })
  uhid: string;

  @Prop({ required: true })
  patientName: string;

  /** The registered number the caller gave (E.164). */
  @Prop({ required: true, index: true })
  phone: string;

  /** What verified the caller, e.g. "caller ID and name" or "name and date of birth". */
  @Prop({ required: true })
  verifiedBy: string;

  /** The provider's call id and the caller's number, when the tool request carries them. */
  @Prop({ index: true })
  providerCallId?: string;

  @Prop({ index: true })
  callerNumber?: string;

  @Prop({ type: [SessionCode], default: [] })
  appointments: SessionCode[];

  @Prop({ type: [SessionCode], default: [] })
  slots: SessionCode[];

  /** What the call changed, in words staff can read. */
  @Prop({ type: [String], default: [] })
  actions: string[];

  /** The last change: booked, rescheduled, cancelled or confirmed. */
  @Prop()
  outcome?: string;

  @Prop()
  appointmentId?: string;

  /** request_callback was used with urgent: staff are already alerted. */
  @Prop()
  urgent?: boolean;

  /** Set when the call's result was logged; the session then ends. */
  @Prop()
  loggedAt?: Date;

  @Prop({ required: true })
  expiresAt: Date;
}

export const InboundSessionSchema = SchemaFactory.createForClass(InboundSession);
InboundSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
