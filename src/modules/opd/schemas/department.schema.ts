import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DepartmentDocument = Department & Document;

/** An outpatient department the reception kiosk offers (General Medicine, Paediatrics...). */
@Schema({ timestamps: true })
export class Department {
  /** kebab-case, e.g. "general-medicine". */
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  /** 1-3 characters of [A-Z0-9]; the default token letters for doctors in this department. */
  @Prop({ required: true })
  tokenPrefix: string;

  /** A MaterialIcons name, shown on the kiosk. */
  @Prop({ default: 'local-hospital' })
  icon: string;

  /** #RRGGBB */
  @Prop({ default: '#1D6FE0' })
  color: string;

  @Prop({ default: 0 })
  order: number;

  @Prop({ default: true })
  active: boolean;
}

export const DepartmentSchema = SchemaFactory.createForClass(Department);
