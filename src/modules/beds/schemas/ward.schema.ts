import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { GenderRule, WardType } from '../bed-types';

export type WardDocument = Ward & Document;

/** A ward or group of rooms of one class, priced per day. */
@Schema({ timestamps: true })
export class Ward {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true })
  name: string;

  /** For tiles and summaries: "Ward A". */
  @Prop({ required: true })
  shortName: string;

  @Prop({ required: true })
  floor: number;

  @Prop({ type: String, required: true })
  type: WardType;

  /** Who may be placed here: men only, women only, or anyone. */
  @Prop({ type: String, required: true })
  gender: GenderRule;

  @Prop({ required: true })
  ratePerDay: number;

  /** Departments close by; ranking prefers this ward for their patients. */
  @Prop({ type: [String], default: [] })
  nearDepartments: string[];

  /** Display order on the board. */
  @Prop({ default: 0 })
  sortOrder: number;
}

export const WardSchema = SchemaFactory.createForClass(Ward);
