import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type HospitalSettingsDocument = HospitalSettings & Document;

// One document holding the workstation settings, section by section, in the
// shape the web app's Settings screen edits.
@Schema({ timestamps: true, minimize: false })
export class HospitalSettings {
  @Prop({ type: Object, default: {} })
  profile: any;

  @Prop({ type: Object, default: {} })
  hospital: any;

  @Prop({ type: Object, default: {} })
  ai: any;

  @Prop({ type: Object, default: {} })
  notifications: any;

  @Prop({ type: Object, default: {} })
  security: any;

  @Prop({ type: Object, default: {} })
  preferences: any;

  /** AI call agent: automation, calling hours, bookable sessions (see calls/call-agent-settings.ts). */
  @Prop({ type: Object, default: {} })
  callAgent: any;
}

export const HospitalSettingsSchema = SchemaFactory.createForClass(HospitalSettings);
