import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

export enum UserRole {
  DOCTOR = 'doctor',
  ADMIN = 'admin',
  STAFF = 'staff',
  NURSE = 'nurse',
  PHARMACIST = 'pharmacist',
  LAB = 'lab',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  // Credential and session-security fields are never loaded unless a query asks
  // for them (`.select('+field')`) and are stripped from every API response.
  @Prop({ required: true, select: false })
  passwordHash: string;

  /** Bumped to invalidate every access token issued before (logout-all, password change). */
  @Prop({ default: 0, select: false })
  tokenVersion: number;

  @Prop({ default: 0, select: false })
  failedLoginAttempts: number;

  @Prop({ type: Date, default: null, select: false })
  lockedUntil: Date | null;

  @Prop({ type: Date, default: null })
  passwordChangedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastLoginAt: Date | null;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  specialty: string;

  @Prop({ default: '' })
  department: string;

  @Prop({ default: '' })
  doctorId: string;

  @Prop({ default: '' })
  avatar: string;

  @Prop({ default: '' })
  phone: string;

  // Least privilege by default; admins assign clinical roles explicitly.
  @Prop({ type: String, enum: UserRole, default: UserRole.STAFF })
  role: UserRole;

  @Prop({ default: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
