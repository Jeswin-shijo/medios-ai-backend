import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type PharmacyBatchDocument = PharmacyBatch & Document & { createdAt?: Date; updatedAt?: Date };

/** A stock take made for a line before the line flipped to issued: pulled once the movement is written. */
export interface BatchTake {
  line: Types.ObjectId;
  qty: number;
  /** Real time. */
  realAt: Date;
}

/** One received batch of a product in one store. `expiry` is `YYYY-MM-DD`; a batch is usable on and before that day. */
@Schema({ timestamps: true })
export class PharmacyBatch {
  @Prop({ required: true, index: true }) product: string;
  @Prop({ required: true }) medicine: string;
  @Prop({ required: true, enum: ['main', 'er'] }) store: 'main' | 'er';
  @Prop({ required: true }) batchNo: string;
  @Prop({ required: true }) expiry: string;
  @Prop({ required: true, min: 0 }) quantity: number;
  @Prop({ required: true, type: { id: String, name: String }, _id: false }) receivedBy: { id: string; name: string };
  /** Clinic clock. */
  @Prop({ required: true, type: Date }) receivedAt: Date;
  @Prop({ type: [{ _id: false, line: { type: MongooseSchema.Types.ObjectId }, qty: Number, realAt: Date }], default: [] }) takes: BatchTake[];
}

export const PharmacyBatchSchema = SchemaFactory.createForClass(PharmacyBatch);
PharmacyBatchSchema.index({ product: 1, store: 1, batchNo: 1 }, { unique: true });
PharmacyBatchSchema.index({ product: 1, store: 1, expiry: 1 });
PharmacyBatchSchema.index({ 'takes.line': 1 }, { sparse: true });
