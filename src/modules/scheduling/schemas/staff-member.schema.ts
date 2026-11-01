import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StaffMemberDocument = StaffMember & Document & { createdAt?: Date; updatedAt?: Date };

/** A person who can be rostered. Only members with a login (userId) can be paged or hold a duty title. */
@Schema({ timestamps: true })
export class StaffMember {
  @Prop({ required: true, trim: true }) name: string;
  @Prop({ type: [String], default: [] }) skills: string[];
  @Prop({ default: '' }) departmentCode: string;
  /** The login; one login belongs to one person. */
  @Prop({ type: String }) userId?: string;
  @Prop({ default: true }) active: boolean;
}

export const StaffMemberSchema = SchemaFactory.createForClass(StaffMember);
StaffMemberSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'string' } } });
