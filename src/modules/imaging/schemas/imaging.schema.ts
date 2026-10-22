import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayDate, displayTime } from '../../../common/utils/clinic-time';

export type ImagingStudyDocument = ImagingStudy & Document;

// A new study is Pending with no report: findings, impression and the radiologist's
// sign-off only exist once PATCH /imaging/:id/report records them.

@Schema({ _id: false })
export class RadiologistReport {
  @Prop({ default: '' })
  findings: string;

  @Prop({ default: '' })
  impression: string;

  @Prop({ default: '' })
  reportedBy: string;

  @Prop({ default: '' })
  reportedOn: string;

  @Prop({ default: 'Preliminary', enum: ['Final Report', 'Preliminary'] })
  status: string;
}

@Schema({ timestamps: true })
export class ImagingStudy {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  title: string;

  @Prop({ default: () => displayDate() })
  date: string;

  @Prop({ default: () => displayTime() })
  time: string;

  @Prop({
    required: true,
    enum: ['X-Ray', 'CT Scan', 'MRI', 'Ultrasound', 'Mammography', 'Others'],
  })
  modality: string;

  @Prop({ required: true })
  bodyPart: string;

  @Prop({ default: '' })
  radiologist: string;

  @Prop({ default: 'Pending', enum: ['Completed', 'Pending', 'Reported'] })
  status: string;

  @Prop({ default: '' })
  thumbnailUrl: string;

  @Prop({ type: [String], default: [] })
  slices: string[];

  @Prop({ type: [String], default: [] })
  findings: string[];

  @Prop({ default: '' })
  impression: string;

  @Prop()
  confidenceScore?: number;

  @Prop({ type: RadiologistReport })
  radiologistReport?: RadiologistReport;
}

export const ImagingStudySchema = SchemaFactory.createForClass(ImagingStudy);
