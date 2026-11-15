import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SupportTemplateDocument = SupportTemplate & Document;

/** An approved text: a family update, a warning-signs list, a procedure's instructions or the emergency line. */
@Schema()
export class SupportTemplate {
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ type: String, default: null }) trigger: string | null;
  @Prop({ required: true, default: '' }) en: string;
  @Prop({ default: '' }) ta: string;
  @Prop({ required: true, default: true }) approved: boolean;
  /** The Tamil has been checked by hospital staff. */
  @Prop({ required: true, default: false }) taChecked: boolean;
  @Prop({ default: '' }) updatedByName: string;
  @Prop({ type: Date, default: () => new Date() }) updatedAt: Date;
}

export const SupportTemplateSchema = SchemaFactory.createForClass(SupportTemplate);
