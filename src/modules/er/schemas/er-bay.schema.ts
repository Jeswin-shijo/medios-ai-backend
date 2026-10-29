import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ErBayDocument = ErBay & Document;

export const ER_BAY_KINDS = ['bay', 'resus', 'stretcher'] as const;
export type ErBayKind = (typeof ER_BAY_KINDS)[number];

/** One place a patient can be treated. A bay holds at most one visit. */
@Schema({ timestamps: true })
export class ErBay {
  @Prop({ required: true }) name: string;
  @Prop({ required: true, type: String, enum: ER_BAY_KINDS }) kind: ErBayKind;
  /** Position in the list; the first free bay of a kind is the lowest `order`. */
  @Prop({ required: true }) order: number;
  @Prop({ default: false }) outOfUse: boolean;
  /** The visit using the bay, if any. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ErVisit' }) visit?: Types.ObjectId;
}

export const ErBaySchema = SchemaFactory.createForClass(ErBay);
ErBaySchema.index({ order: 1 });
ErBaySchema.index({ visit: 1 });
