import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ProcedureBookingDocument = ProcedureBooking & Document & { createdAt?: Date; updatedAt?: Date };
export const PROCEDURE_STATUSES = ['requested', 'booked', 'in-progress', 'done', 'cancelled', 'cant-book'] as const;
export type ProcedureStatus = (typeof PROCEDURE_STATUSES)[number];

/** One procedure for one patient: a room, a time and a team. Schedule times are clinic clock. */
@Schema({ timestamps: true })
export class ProcedureBooking {
  /** PR-0001 */
  @Prop({ required: true, unique: true }) number: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'Patient', index: true }) patient: Types.ObjectId;
  @Prop({ required: true }) patientUhid: string;
  @Prop({ required: true }) patientName: string;
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, index: true }) case: Types.ObjectId;
  @Prop({ required: true }) procedure: string;
  @Prop({ required: true, type: String, enum: ['stat', 'urgent', 'routine'] }) priority: 'stat' | 'urgent' | 'routine';
  @Prop({ required: true, type: String, enum: PROCEDURE_STATUSES, default: 'requested', index: true }) status: ProcedureStatus;
  @Prop() room?: string;
  @Prop({ type: Date }) start?: Date;
  @Prop({ type: Date }) end?: Date;
  @Prop({
    type: [{ role: String, staffId: String, name: String, unfilled: Boolean, _id: false }],
    default: [],
  })
  team: { role: string; staffId?: string; name?: string; unfilled?: boolean }[];
  @Prop({ required: true, type: { id: String, name: String }, _id: false }) requestedBy: { id: string; name: string };
  @Prop({ default: '' }) note: string;
  /** The earliest the booking may start. */
  @Prop({ required: true, type: Date }) earliest: Date;
  @Prop({ type: { start: Date, room: String }, _id: false }) bumpedFrom?: { start: Date; room: string };
  @Prop({ type: [{ at: Date, what: String, by: String, _id: false }], default: [] }) history: { at: Date; what: string; by: string }[];
  /** Real time: set after the first message about this booking went out. */
  @Prop({ type: Date }) announcedAt?: Date;
  @Prop({ type: Date }) startedAt?: Date;
  @Prop({ type: Date }) doneAt?: Date;
  @Prop({ type: { at: Date, by: String, reason: String }, _id: false }) cancelled?: { at: Date; by: string; reason: string };
}

export const ProcedureBookingSchema = SchemaFactory.createForClass(ProcedureBooking);
ProcedureBookingSchema.index({ room: 1, start: 1 });
