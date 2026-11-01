import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested, ValidationOptions, registerDecorator,
} from 'class-validator';
import { PROCEDURES, SKILLS } from '../scheduling-catalogue';
import { PROCEDURE_STATUSES } from '../schemas/procedure-booking.schema';
import { CONSULT_STATUSES } from '../schemas/consult-request.schema';

const PRIORITIES = ['stat', 'urgent', 'routine'];
const SHIFT_KEYS = ['morning', 'evening', 'night', 'on-call'];
const PROCEDURE_KEYS = PROCEDURES.map((p) => p.key);

/** YYYY-MM-DD. */
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** hh:mm AM, as appointments are stored ("09:30 AM"). */
export const TIME = /^(0[1-9]|1[0-2]):[0-5]\d (AM|PM)$/;
/** A moment on the clinic clock without a zone: 2026-10-05T14:30 (seconds allowed). */
export const MOMENT = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
/** A day, or a moment on the clinic clock. */
const DAY_OR_MOMENT = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?)?$/;
const DAY_MESSAGE = 'must be a date as YYYY-MM-DD';
const TIME_MESSAGE = 'must be a time like 09:30 AM';

/** True when the YYYY-MM-DD part names a real calendar day (round-tripped through local date parts). */
export function isRealDay(day: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/** The value must match the pattern and name a real day. */
function RealDate(pattern: RegExp, message: string, options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'realDate',
      target: target.constructor,
      propertyName,
      options: { message: `${propertyName} ${message}`, ...options },
      validator: { validate: (v: unknown) => typeof v === 'string' && pattern.test(v) && isRealDay(v) },
    });
}
const RealDay = (name = 'date') => RealDate(DAY, DAY_MESSAGE, { message: `${name} ${DAY_MESSAGE}` });
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SchedulingIdParam {
  @IsMongoId() id: string;
}

export class RoomKeyParam {
  @Matches(/^[a-z0-9-]{1,40}$/) key: string;
}

// ---------- queries ----------

export class OverviewQueryDto {
  @IsOptional() @RealDay('day') day?: string;
}

export class SchedulingSnapshotQueryDto {
  @IsOptional() @IsIn(['24h', '7d']) range?: '24h' | '7d';
}

export class SchedulingSlotsQueryDto {
  /** A day (YYYY-MM-DD) or a moment; default now. */
  @IsOptional() @RealDate(DAY_OR_MOMENT, 'from must be a date or a date and time', { message: 'from must be a date or a date and time' }) from?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) count?: number;
}

export class AppointmentsQueryDto {
  @RealDay('date') date: string;
  @IsOptional() @IsMongoId() doctorId?: string;
}

export class ProceduresQueryDto {
  @IsOptional() @IsIn([...PROCEDURE_STATUSES]) status?: string;
  @IsOptional() @RealDay('day') day?: string;
}

export class BoardQueryDto {
  @RealDay('day') day: string;
}

export class ConsultsQueryDto {
  @IsOptional() @IsIn([...CONSULT_STATUSES]) status?: (typeof CONSULT_STATUSES)[number];
}

export class RosterQueryDto {
  @RealDay('from') from: string;
}

export class WaitlistQueryDto {
  @IsOptional() @IsIn(['open', 'resolved', 'cancelled']) status?: 'open' | 'resolved' | 'cancelled';
}

export class SchedulingDoctorsQueryDto {
  @IsOptional() @IsIn(['true', 'false']) activeOnly?: 'true' | 'false';
}

// ---------- doctors and appointments ----------

export class LeaveRangeDto {
  @RealDay('from') from: string;
  @RealDay('to') to: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) reason?: string;
}

export class DoctorProfileDto {
  @IsOptional() @IsInt() @Min(5) @Max(60) slotMinutes?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => LeaveRangeDto) leave?: LeaveRangeDto[];
}

export class BookAppointmentDto {
  @IsMongoId() patientId: string;
  @IsMongoId() doctorId: string;
  @RealDay('date') date: string;
  @Matches(TIME, { message: `time ${TIME_MESSAGE}` }) time: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) type?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) condition?: string;
}

export class MoveAppointmentDto {
  @RealDay('date') date: string;
  @Matches(TIME, { message: `time ${TIME_MESSAGE}` }) time: string;
  @IsOptional() @IsMongoId() doctorId?: string;
}

/** A reason of 1 to 300 characters (everything except a consult). */
export class SchedulingReasonDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

// ---------- procedures ----------

export class ProcedureRequestDto {
  @IsMongoId() patientId: string;
  @IsIn(PROCEDURE_KEYS) procedure: string;
  @IsIn(PRIORITIES) priority: 'stat' | 'urgent' | 'routine';
  /** A clinic day or a moment; default now. */
  @IsOptional() @RealDate(DAY_OR_MOMENT, 'earliest must be a date or a date and time', { message: 'earliest must be a date or a date and time' }) earliest?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

export class ActivateCathLabDto {
  @IsMongoId() patientId: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

export class NoteDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

// ---------- consults ----------

export class ConsultRequestDto {
  @IsMongoId() patientId: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(20) departmentCode: string;
  @IsIn(PRIORITIES) priority: 'stat' | 'urgent' | 'routine';
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

export class ConsultReasonDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

export class RepageDto {
  @IsMongoId() userId: string;
}

// ---------- roster, staff, rooms ----------

export class RosterEntryDto {
  @RealDay('date') date: string;
  @IsIn(SHIFT_KEYS) shift: 'morning' | 'evening' | 'night' | 'on-call';
  @IsMongoId() staffId: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) departmentCode?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) titles?: string[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) note?: string;
}

export class CopyWeekDto {
  @RealDay('from') from: string;
  @RealDay('to') to: string;
}

export class StaffDto {
  @IsOptional() @IsMongoId() id?: string;
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsIn(SKILLS, { each: true }) skills?: string[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) departmentCode?: string;
  @IsOptional() @IsMongoId() userId?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class RoomBlockDto {
  @RealDate(MOMENT, 'from must be a date and time like 2026-10-05T14:30', { message: 'from must be a date and time like 2026-10-05T14:30' }) from: string;
  @RealDate(MOMENT, 'to must be a date and time like 2026-10-05T14:30', { message: 'to must be a date and time like 2026-10-05T14:30' }) to: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) reason?: string;
}

// ---------- waitlist and follow-ups ----------

export class WaitBookDto {
  @IsInt() @Min(0) @Max(9) index: number;
}

export class FollowUpDto {
  @IsMongoId() patientId: string;
  @IsOptional() @IsMongoId() doctorId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) departmentCode?: string;
  @IsInt() @Min(1) @Max(365) inDays: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}
