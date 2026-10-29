import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';
import type { UserRole } from '../../users/schemas/user.schema';
import type { AgentKey } from '../coordinator-types';

export type ApprovalDocument = Approval & Document;

export type ApprovalState = 'open' | 'approved' | 'rejected' | 'done';

/** Something an agent needs a person to decide. The type (registered by the agent) says who may decide. */
@Schema({ timestamps: true })
export class Approval {
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) case?: Types.ObjectId | null;
  @Prop({ required: true, type: String }) type: string;
  @Prop({ required: true, type: String }) agent: AgentKey;
  @Prop({ required: true, type: String }) summary: string;
  @Prop({ type: [String], default: [] }) roles: UserRole[];
  @Prop({ required: true, type: { kind: { type: String, enum: ['approve', 'open'], required: true }, label: { type: String, required: true } }, _id: false })
  primary: { kind: 'approve' | 'open'; label: string };
  @Prop({ type: { kind: { type: String, required: true }, id: { type: String, required: true } }, _id: false })
  source?: { kind: string; id: string };
  @Prop({ type: String, default: 'open', enum: ['open', 'approved', 'rejected', 'done'] }) state: ApprovalState;
  @Prop({
    type: { kind: { type: String, enum: ['title', 'role'], required: true }, key: { type: String, required: true }, label: { type: String, required: true } },
    _id: false,
  })
  assignedTo?: { kind: 'title' | 'role'; key: string; label: string };
  @Prop({ type: [{ byName: String, at: Date, text: String, _id: false }], default: [] })
  notes: { byName: string; at: Date; text: string }[];
  @Prop({ type: String }) decidedByName?: string;
  @Prop({ type: Date }) decidedAt?: Date;
}

export const ApprovalSchema = SchemaFactory.createForClass(Approval);
ApprovalSchema.index({ state: 1, createdAt: -1 });
// One open approval per source (approvals without a source are not indexed), so an agent asking twice cannot double up.
ApprovalSchema.index({ 'source.kind': 1, 'source.id': 1 }, { unique: true, partialFilterExpression: { state: { $eq: 'open' }, 'source.id': { $exists: true } } });
