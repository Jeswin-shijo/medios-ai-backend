import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

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

  @Prop({ default: 'After food' })
  instructions: string;

  @Prop({ default: '' })
  indication: string;

  @Prop({ default: 'Active', enum: ['Active', 'Paused', 'Stopped', 'Completed'] })
  status: string;

  @Prop({ default: '26 Sep 2026' })
  startDate: string;

  @Prop({ default: 94 })
  adherenceScore: number;
}

export const MedicationSchema = SchemaFactory.createForClass(Medication);
