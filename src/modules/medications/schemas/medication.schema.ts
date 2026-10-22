import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayDate } from '../../../common/utils/clinic-time';

export type MedicationDocument = Medication & Document;

@Schema({ timestamps: true })
export class Medication {
  @Prop({ required: true, index: true })
  uhid: string;

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

  @Prop({ default: '' })
  instructions: string;

  @Prop({ default: '' })
  indication: string;

  @Prop({ default: 'Active', enum: ['Active', 'Paused', 'Stopped', 'Completed'] })
  status: string;

  @Prop({ default: () => displayDate() })
  startDate: string;

  /** Percentage of doses taken, once adherence has been measured. */
  @Prop({ min: 0, max: 100 })
  adherenceScore?: number;
}

export const MedicationSchema = SchemaFactory.createForClass(Medication);
