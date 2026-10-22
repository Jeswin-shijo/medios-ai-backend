import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { displayDate } from '../../../common/utils/clinic-time';

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

  @Prop({ default: () => displayDate() })
  date: string;

  @Prop({ default: '' })
  author: string;

  @Prop({ default: '' })
  department: string;

  @Prop({ default: 'pdf', enum: ['pdf', 'doc', 'image', 'dicom'] })
  fileType: string;

  @Prop({ default: '' })
  fileSize: string;

  // Only PATCH /documents/:id/sign marks a document Signed.
  @Prop({
    default: 'Draft',
    enum: ['Signed', 'Pending Signature', 'Draft', 'Archived'],
  })
  status: string;

  @Prop({ default: '' })
  signedBy: string;

  @Prop({ default: '' })
  signedOn: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ default: '' })
  fileUrl: string;
}

export const ClinicalDocumentSchema = SchemaFactory.createForClass(ClinicalDocument);
