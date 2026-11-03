import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import { PRICE_CATEGORIES, PriceCategory } from '../revenue-catalogue';
import { ActorRef, ActorRefSchema } from './actor-ref';

export type ChargeLineDocument = ChargeLine & Document;

/** A correction's discount and write-off lines carry these two extra categories (R19), so totals can tell them from charges. */
export const LINE_CATEGORIES = [...PRICE_CATEGORIES, 'discount', 'write-off'] as const;
export type LineCategory = (typeof LINE_CATEGORIES)[number];

@Schema({ _id: false })
export class ChargeSource {
  @Prop({ required: true }) type: string;
  @Prop({ required: true }) ref: string;
}
export const ChargeSourceSchema = SchemaFactory.createForClass(ChargeSource);

/** One line on a bill. Never edited or deleted: changes are corrections. */
@Schema({ timestamps: true })
export class ChargeLine {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  bill: Types.ObjectId;

  @Prop({ required: true })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, required: true, enum: LINE_CATEGORIES })
  category: LineCategory;

  @Prop({ required: true, min: 1 })
  qty: number;

  /** Negative only on a correction's credit line. */
  @Prop({ required: true })
  unitPrice: number;

  /** qty x unitPrice; negative only for a correction's credit line. */
  @Prop({ required: true })
  amount: number;

  @Prop({ type: ChargeSourceSchema, required: true })
  source: ChargeSource;

  @Prop({ type: Date, required: true })
  chargedAt: Date;

  @Prop({ type: ActorRefSchema, required: true })
  by: ActorRef;

  @Prop({ default: false })
  needsPrice: boolean;

  /** Why a missed charge was added by hand. */
  @Prop({ default: '' })
  reason: string;

  @Prop({ default: false })
  reversed: boolean;

  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] })
  corrections: Types.ObjectId[];
}

export const ChargeLineSchema = SchemaFactory.createForClass(ChargeLine);
/** One charge per source across all bills: a source is never billed twice, whichever bill routing picks. */
ChargeLineSchema.index({ 'source.type': 1, 'source.ref': 1 }, { unique: true });
ChargeLineSchema.index({ bill: 1, chargedAt: 1 });
