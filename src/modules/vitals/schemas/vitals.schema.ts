import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VitalsRecordDocument = VitalsRecord & Document;

@Schema({ timestamps: true })
export class VitalsRecord {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ default: 'Today, 09:15 AM' })
  recordedAt: string;

  @Prop({ default: 'Nurse Anitha' })
  recordedBy: string;

  @Prop({ required: true })
  bpSystolic: number;

  @Prop({ required: true })
  bpDiastolic: number;

  @Prop({ required: true })
  heartRate: number;

  @Prop({ default: 98.4 })
  temperature: number;

  @Prop({ default: 98 })
  spo2: number;

  @Prop({ default: 18 })
  respiratoryRate: number;

  @Prop({ default: 118 })
  bloodSugarFasting: number;

  @Prop({ default: 154 })
  bloodSugarPostPrandial: number;

  @Prop({ default: 74 })
  weightKg: number;

  @Prop({ default: 172 })
  heightCm: number;

  @Prop({ default: 25.0 })
  bmi: number;

  @Prop({ default: 'Overweight', enum: ['Normal', 'Overweight', 'Underweight', 'Obese'] })
  bmiStatus: string;

  @Prop({ default: 'Warning', enum: ['Normal', 'Warning', 'Critical'] })
  status: string;

  @Prop({ default: '' })
  notes: string;
}

export const VitalsRecordSchema = SchemaFactory.createForClass(VitalsRecord);
