import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { PRICE_CATEGORIES, PriceCategory } from '../revenue-catalogue';

export type PriceItemDocument = PriceItem & Document;

/** One change to a price, kept for the record. Existing charges are never touched. */
@Schema({ _id: false })
export class PriceChange {
  @Prop({ type: Date, required: true })
  at: Date;

  @Prop({ required: true })
  by: string;

  @Prop({ type: Number, default: null })
  from: number | null;

  @Prop({ type: Number, required: true })
  to: number;
}
export const PriceChangeSchema = SchemaFactory.createForClass(PriceChange);

/** A price in the hospital's price list. */
@Schema({ timestamps: true })
export class PriceItem {
  @Prop({ required: true, unique: true, match: /^[a-z]+:[a-z0-9.-]+$/ })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, required: true, enum: PRICE_CATEGORIES })
  category: PriceCategory;

  @Prop({ default: 'each' })
  unit: string;

  /** Whole rupees. */
  @Prop({ required: true, min: 0 })
  price: number;

  @Prop({ default: true })
  active: boolean;

  @Prop({ type: [PriceChangeSchema], default: [] })
  log: PriceChange[];
}

export const PriceItemSchema = SchemaFactory.createForClass(PriceItem);
