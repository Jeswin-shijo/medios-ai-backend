import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type DutyTitleDocument = DutyTitle & Document;

/** A role someone holds on duty (for example "Duty administrator"). Empty holders means the admins. */
@Schema({ timestamps: true })
export class DutyTitle {
  @Prop({ required: true, unique: true }) key: string;
  @Prop({ required: true }) label: string;
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] }) holders: Types.ObjectId[];
}

export const DutyTitleSchema = SchemaFactory.createForClass(DutyTitle);
