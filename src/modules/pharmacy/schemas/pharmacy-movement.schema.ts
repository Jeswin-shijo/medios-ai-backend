import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type PharmacyMovementDocument = PharmacyMovement & Document & { createdAt?: Date; updatedAt?: Date };
export const MOVEMENT_KINDS = ['received', 'issued', 'adjusted'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const ADJUST_REASONS = ['damaged', 'expired', 'count-correction'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

/** The stock movement log: one row per change of a batch's quantity. */
@Schema({ timestamps: true })
export class PharmacyMovement {
  @Prop({ required: true, type: MongooseSchema.Types.ObjectId, index: true }) batch: Types.ObjectId;
  @Prop({ required: true }) product: string;
  @Prop({ required: true, enum: ['main', 'er'] }) store: 'main' | 'er';
  @Prop({ required: true }) change: number;
  @Prop({ required: true, type: String, enum: MOVEMENT_KINDS }) kind: MovementKind;
  @Prop({ default: '' }) reason: string;
  @Prop({ type: MongooseSchema.Types.ObjectId }) line?: Types.ObjectId;
  @Prop({ required: true, type: { id: String, name: String }, _id: false }) by: { id: string; name: string };
  /** Clinic clock. */
  @Prop({ required: true, type: Date }) at: Date;
}

export const PharmacyMovementSchema = SchemaFactory.createForClass(PharmacyMovement);
// One issued movement per batch and line: a repeat write finds the first.
PharmacyMovementSchema.index({ batch: 1, line: 1 }, { unique: true, partialFilterExpression: { kind: 'issued' } });
PharmacyMovementSchema.index({ product: 1, store: 1, at: -1 });
