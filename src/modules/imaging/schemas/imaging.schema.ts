import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ImagingStudyDocument = ImagingStudy & Document;

@Schema({ _id: false })
export class RadiologistReport {
  @Prop({ default: 'Bilateral lung fields clear. Cardiac silhouette is normal in size and configuration.' })
  findings: string;

  @Prop({ default: 'No active focal cardiopulmonary abnormality.' })
  impression: string;

  @Prop({ default: 'Dr. Priya Sundaram, MD Radiodiagnosis' })
  reportedBy: string;

  @Prop({ default: '26 Sep 2026, 11:45 AM' })
  reportedOn: string;

  @Prop({ default: 'Final Report', enum: ['Final Report', 'Preliminary'] })
  status: string;
}

@Schema({ timestamps: true })
export class ImagingStudy {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '26 Sep 2026' })
  date: string;

  @Prop({ default: '10:15 AM' })
  time: string;

  @Prop({
    required: true,
    enum: ['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'Mammography', 'Others'],
  })
  modality: string;

  @Prop({ default: 'Chest' })
  bodyPart: string;

  @Prop({ default: 'Dr. Priya Sundaram' })
  radiologist: string;

  @Prop({ default: 'Reported', enum: ['Completed', 'Pending', 'Reported'] })
  status: string;

  @Prop({ default: 'https://images.unsplash.com/photo-1516549655169-df83a0774514?auto=format&fit=crop&w=800&q=80' })
  thumbnailUrl: string;

  @Prop({ type: [String], default: [] })
  slices: string[];

  @Prop({ type: [String], default: [] })
  findings: string[];

  @Prop({ default: '' })
  impression: string;

  @Prop({ default: 96 })
  confidenceScore: number;

  @Prop({ type: RadiologistReport, default: () => ({}) })
  radiologistReport: RadiologistReport;
}

export const ImagingStudySchema = SchemaFactory.createForClass(ImagingStudy);
