import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayDate } from '../../../common/utils/clinic-time';

export type PrescriptionDocument = Prescription & Document;

@Schema()
export class PrescriptionItem {
  @Prop({ required: true })
  medicine: string;

  @Prop({ default: '' })
  brand: string;

  @Prop({ required: true })
  dose: string;

  @Prop({ required: true, enum: ['OD', 'BD', 'TDS', 'QID', 'HS', 'SOS'] })
  frequency: string;

  @Prop({ required: true })
  duration: string;

  @Prop({ default: 'Oral' })
  route: string;

  @Prop({
    enum: ['After food', 'Before food', 'At night', 'SOS (Fever)', 'With warm water'],
  })
  instructions?: string;

  @Prop({ default: '' })
  indication: string;

  @Prop({ default: 'Active', enum: ['Active', 'Paused', 'Stopped', 'Completed'] })
  status: string;

  @Prop({ default: () => displayDate() })
  startDate: string;
}

@Schema({ _id: false })
export class PrescriptionOptions {
  @Prop({ default: true })
  printAdvice: boolean;

  @Prop({ default: true })
  includeDiagnosis: boolean;

  @Prop({ default: true })
  includeVitals: boolean;

  @Prop({ default: true })
  includeNextVisit: boolean;

  @Prop({ default: false })
  includeLabSummary: boolean;
}

@Schema({ timestamps: true })
export class Prescription {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ default: () => displayDate() })
  date: string;

  @Prop({ default: '' })
  doctor: string;

  @Prop({ default: '' })
  type: string;

  @Prop({ type: [PrescriptionItem], default: [] })
  items: PrescriptionItem[];

  @Prop({ default: '' })
  additionalInstructions: string;

  @Prop({ type: PrescriptionOptions, default: () => ({}) })
  options: PrescriptionOptions;

  /** Advanced by the server on every save (never from a client body); Pharmacy syncs the revisions it has not seen. */
  @Prop({ default: 0 })
  pharmacyRev: number;

  /** The doctor who saved the current revision, set by the server from the signed-in user. */
  @Prop({ type: { id: String, name: String }, _id: false })
  pharmacyBy?: { id: string; name: string };
}

export const PrescriptionSchema = SchemaFactory.createForClass(Prescription);
