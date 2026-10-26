import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { clinicNow } from '../../../common/utils/clinic-time';
import { BedState, Feature, PatientGender } from '../bed-types';

export type BedDocument = Bed & Document;

export const BED_STATES: BedState[] = ['free', 'held', 'occupied', 'cleaning', 'blocked'];

/**
 * free → held → occupied → cleaning → free, and free ↔ blocked. BedsService changes
 * the state with one conditional update each, so one bed never goes to two patients.
 */
@Schema({ timestamps: true })
export class Bed {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Ward', required: true, index: true })
  ward: Types.ObjectId;

  /** As staff say it: "Ward A • Bed 4". */
  @Prop({ required: true })
  label: string;

  @Prop({ required: true })
  number: number;

  /** Beds sharing a room (twin rooms). */
  @Prop()
  room?: string;

  @Prop({ type: [String], default: [] })
  features: Feature[];

  @Prop({ type: String, enum: BED_STATES, default: 'free', index: true })
  state: BedState;

  /** When the bed entered its state, on the clinic clock. */
  @Prop({ type: Date, default: () => clinicNow() })
  stateSince: Date;

  /** The holder's user id. A hold is only for the 5-minute confirm step. */
  @Prop()
  holdBy?: string;

  /** Real time, not the clinic clock; past it, anyone may take the bed. */
  @Prop()
  holdExpiresAt?: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  holdSuggestion?: Types.ObjectId;

  /** The gender of the patient the bed is held for: a held twin bed keeps its room to one gender. */
  @Prop({ type: String })
  holdGender?: PatientGender;

  /** The active admission in this bed; absent for a sample occupant. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Admission', default: null })
  admission?: Types.ObjectId | null;

  /** The occupant's gender, for the twin-room rule. */
  @Prop({ type: String })
  occupantGender?: PatientGender;

  @Prop()
  blockedReason?: string;

  /** Seeded as occupied with no real patient behind it. */
  @Prop({ default: false })
  sample: boolean;
}

export const BedSchema = SchemaFactory.createForClass(Bed);
