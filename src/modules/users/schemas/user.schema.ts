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

  @Prop({ default: 'General Physician' })
  specialty: string;

  @Prop({ default: 'OPD / General Medicine' })
  department: string;

  @Prop({ default: 'MHK-DOC-042' })
  doctorId: string;

  @Prop({ default: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=400&q=80' })
  avatar: string;

  @Prop({ default: '+91 98765 43210' })
  phone: string;

  @Prop({ type: String, enum: UserRole, default: UserRole.DOCTOR })
  role: UserRole;

  @Prop({ default: true })
  isActive: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);
