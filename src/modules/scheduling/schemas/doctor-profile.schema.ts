import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DoctorProfileDocument = DoctorProfile & Document & { createdAt?: Date; updatedAt?: Date };

/** Scheduling's extras for an OP doctor: the slot length and leave. */
@Schema({ timestamps: true })
export class DoctorProfile {
  @Prop({ required: true, unique: true }) doctorId: string;
  @Prop({ required: true, default: 15 }) slotMinutes: number;
  /** Clinic days, YYYY-MM-DD, both ends included. */
  @Prop({ type: [{ from: String, to: String, reason: { type: String, default: '' }, _id: false }], default: [] })
  leave: { from: string; to: string; reason: string }[];
}

export const DoctorProfileSchema = SchemaFactory.createForClass(DoctorProfile);
