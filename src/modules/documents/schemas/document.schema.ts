import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ClinicalDocumentDocument = ClinicalDocument & Document;

@Schema({ timestamps: true })
export class ClinicalDocument {
  @Prop({ required: true, index: true })
  uhid: string;

  @Prop({ required: true })
  title: string;

  @Prop({
    required: true,
    enum: [
      'Discharge Summary',
      'Consent Form',
      'Referral Letter',
      'Insurance & Claims',
      'Lab / Diagnostic',
      'Medical Certificate',
      'Prescription / Bill',
    ],
  })
  category: string;

  @Prop({ default: '26 Sep 2026' })
  date: string;

  @Prop({ default: 'Dr. Shajin' })
  author: string;

  @Prop({ default: 'General Medicine' })
  department: string;

  @Prop({ default: 'pdf', enum: ['pdf', 'doc', 'image', 'dicom'] })
  fileType: string;

  @Prop({ default: '2.4 MB' })
  fileSize: string;

  @Prop({
    default: 'Signed',
    enum: ['Signed', 'Pending Signature', 'Draft', 'Archived'],
  })
  status: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ default: '' })
  fileUrl: string;
}

export const ClinicalDocumentSchema = SchemaFactory.createForClass(ClinicalDocument);
