import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserDocument = User & Document;

export enum UserRole {
  DOCTOR = 'doctor',
  ADMIN = 'admin',
  STAFF = 'staff',
  NURSE = 'nurse',
  PHARMACIST = 'pharmacist',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

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

  @Prop({ type: String, enum: UserRole, default: UserRole.DOCTOR })
  role: UserRole;

  @Prop({ default: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
