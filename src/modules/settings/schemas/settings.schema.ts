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

  /** Token queue: rooms, token prefix, what the waiting-room display shows (see queue/queue-settings.ts). */
  @Prop({ type: Object, default: {} })
  queue: any;

  /** Reception kiosk: payment methods, default doctor, UPI payee, slip footer (see reception/reception-settings.ts). */
  @Prop({ type: Object, default: {} })
  reception: any;

  /** Coordinator: on/off switches for coordination rules, by rule key (see coordinator/rules.service.ts). */
  @Prop({ type: Object, default: {} })
  coordinator: { rules?: Record<string, boolean> };

  /** ER: minutes from arrival per pathway step, by `<pathway>.<step>` key (see er/er-rules.ts); missing keys use the defaults. */
  @Prop({ type: Object, default: {} })
  er: { targets?: Record<string, number> };

  /** Lab: turnaround targets per test (minutes), critical limits per `<test>.<parameter>`, and who changed the limits (last 50). */
  @Prop({ type: Object, default: {} })
  lab: {
    targets?: Record<string, { stat?: number; routine?: number }>;
    criticalLimits?: Record<string, { low?: number | null; high?: number | null }>;
    limitsHistory?: { by: string; at: Date; changes: { key: string; from: unknown; to: unknown }[] }[];
  };

  /** Pharmacy: check, issue and query targets in minutes per priority, and the near-expiry window in days (see PharmacySettingsService). */
  @Prop({ type: Object, default: {} })
  pharmacy: {
    targets?: Partial<Record<'check' | 'issue' | 'query', Partial<Record<'stat' | 'urgent' | 'routine', number>>>>;
    nearExpiryDays?: number;
  };

  /** Scheduling: consult, procedure and roster settings (see SchedulingSettingsService). */
  @Prop({ type: Object, default: {} })
  scheduling: Record<string, unknown>;

  /** Revenue: price, deposit and approval settings (see RevenueSettingsService). */
  @Prop({ type: Object, default: {} })
  revenue: Record<string, unknown>;

  /** Discharge: leave and summary targets, reminder time, warning signs (see the Discharge settings service). */
  @Prop({ type: Object, default: {} })
  discharge: Record<string, unknown>;
}

export const HospitalSettingsSchema = SchemaFactory.createForClass(HospitalSettings);
