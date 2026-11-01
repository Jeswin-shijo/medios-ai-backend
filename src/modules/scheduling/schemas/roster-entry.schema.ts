import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type RosterEntryDocument = RosterEntry & Document & { createdAt?: Date; updatedAt?: Date };

/** One person on one shift of one clinic day, with the duty titles they hold during it. */
@Schema({ timestamps: true })
export class RosterEntry {
  /** Clinic day, YYYY-MM-DD. A night or on-call entry runs into the next morning. */
  @Prop({ required: true }) date: string;
  @Prop({ required: true, type: String, enum: ['morning', 'evening', 'night', 'on-call'] }) shift: 'morning' | 'evening' | 'night' | 'on-call';
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, ref: 'StaffMember' }) staff: Types.ObjectId;
  @Prop() departmentCode?: string;
  @Prop({ type: [String], default: [] }) titles: string[];
  @Prop({ default: '' }) note: string;
}

export const RosterEntrySchema = SchemaFactory.createForClass(RosterEntry);
RosterEntrySchema.index({ date: 1, shift: 1, staff: 1 }, { unique: true });
