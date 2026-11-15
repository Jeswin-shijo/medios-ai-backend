import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SupportFaqDocument = SupportFaq & Document;

/** A hospital fact the call agent may read out. */
@Schema()
export class SupportFaq {
  @Prop({ required: true, unique: true }) topic: string;
  @Prop({ required: true }) title: string;
  @Prop({ type: [String], default: [] }) keywords: string[];
  @Prop({ required: true, default: '' }) en: string;
  @Prop({ default: '' }) ta: string;
  @Prop({ required: true, default: true }) approved: boolean;
  @Prop({ required: true, default: false }) taChecked: boolean;
  @Prop({ default: '' }) updatedByName: string;
  @Prop({ type: Date, default: () => new Date() }) updatedAt: Date;
}

export const SupportFaqSchema = SchemaFactory.createForClass(SupportFaq);
