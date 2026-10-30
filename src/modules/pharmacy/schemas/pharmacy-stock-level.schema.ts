import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PharmacyStockLevelDocument = PharmacyStockLevel & Document & { createdAt?: Date; updatedAt?: Date };

/** The reorder level of a product in a store, and the claim that its low-stock alert was raised (real time). */
@Schema({ timestamps: true })
export class PharmacyStockLevel {
  @Prop({ required: true }) product: string;
  @Prop({ required: true, enum: ['main', 'er'] }) store: 'main' | 'er';
  @Prop({ required: true, min: 0, max: 100000 }) reorderLevel: number;
  @Prop({ type: Date }) lowAlertedAt?: Date;
}

export const PharmacyStockLevelSchema = SchemaFactory.createForClass(PharmacyStockLevel);
PharmacyStockLevelSchema.index({ product: 1, store: 1 }, { unique: true });
