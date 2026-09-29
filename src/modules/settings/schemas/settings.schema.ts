import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type HospitalSettingsDocument = HospitalSettings & Document;

@Schema({ timestamps: true })
export class HospitalSettings {
  @Prop({ type: Object, default: {} })
  profile: any;

  @Prop({ type: Object, default: {} })
  hospital: any;

  @Prop({ type: Object, default: {} })
  aiConfig: any;

  @Prop({ type: Object, default: {} })
  clinical: any;

  @Prop({ type: Object, default: {} })
  notifications: any;

  @Prop({ type: Object, default: {} })
  security: any;
}

export const HospitalSettingsSchema = SchemaFactory.createForClass(HospitalSettings);
