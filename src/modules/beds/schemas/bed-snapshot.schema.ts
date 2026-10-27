import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { WardType } from '../bed-types';

export type BedSnapshotDocument = BedSnapshot & Document;

export interface SnapshotTotals {
  total: number;
  occupied: number;
  free: number;
  cleaning: number;
  blocked: number;
  held: number;
}

export type SnapshotTypeCounts = Omit<SnapshotTotals, 'held'>;

/** What the overview's two "expected" cards showed when the snapshot was taken. */
export interface SnapshotExpected {
  discharges: number;
  admissions: number;
}

/** The bed counts at one hour. `hour` is the real clock (not the clinic clock), so days never collide. */
@Schema({ timestamps: false })
export class BedSnapshot {
  /** The real moment, cut to the hour. One snapshot per hour. */
  @Prop({ required: true, unique: true })
  hour: Date;

  @Prop({ required: true })
  at: Date;

  @Prop({ type: Object, required: true })
  totals: SnapshotTotals;

  @Prop({ type: Object, required: true })
  byType: Partial<Record<WardType, SnapshotTypeCounts>>;

  /** Missing on snapshots from before the cards had trends. */
  @Prop({ type: Object })
  expected?: SnapshotExpected;
}

export const BedSnapshotSchema = SchemaFactory.createForClass(BedSnapshot);
