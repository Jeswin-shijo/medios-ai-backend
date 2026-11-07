import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { LineDto } from '../../pharmacy/dto/pharmacy.dto';
import { CONDITIONS, Condition, DISCHARGE_KINDS, DischargeKind, LINE_KEYS, LineKey } from '../discharge-catalogue';
import { SHOWN_STATUSES } from '../discharge-overview.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const NONE = 'none';
/** The take-home or follow-up choice is checked as an object only when it is not the literal "none". */
const unlessNone = (key: 'takeHome' | 'followUp') => ValidateIf((o: Record<string, unknown>) => o[key] !== NONE);

export class PlanIdParam {
  @IsMongoId() planId: string;
}

export class DischargeOrderIdParam {
  @IsMongoId() id: string;
}

export class AdmissionIdParam {
  @IsMongoId() admissionId: string;
}

export class PatientIdParam {
  @IsMongoId() patientId: string;
}

/** `POST /discharge/orders/:id/lines/:key`. */
export class DischargeLineParam {
  @IsMongoId() id: string;
  @IsIn(LINE_KEYS as readonly string[]) key: LineKey;
}

/** `POST /discharge/orders/:id/lab/:requestId/follow-up-later`. */
export class DischargeLabRequestParam {
  @IsMongoId() id: string;
  @IsMongoId() requestId: string;
}

/** 1 to 10 take-home medicines, each a Pharmacy line. */
export class TakeHomeDto {
  @ApiProperty({ type: [LineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
}

/** "In N days with" a doctor or a department (Scheduling's follow-up order). */
export class FollowUpChoiceDto {
  @ApiProperty({ minimum: 1, maximum: 365 }) @IsInt() @Min(1) @Max(365) inDays: number;
  @ApiPropertyOptional({ description: 'An OP doctor id' }) @IsOptional() @IsMongoId() doctorId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(20) departmentCode?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

/** `POST /discharge/plans/:planId/order`. The service checks which fields each kind needs. */
export class OrderDischargeDto {
  @ApiProperty({ enum: DISCHARGE_KINDS }) @IsIn(DISCHARGE_KINDS as readonly string[]) kind: DischargeKind;
  @ApiPropertyOptional({ description: 'Clinic time, today or tomorrow; default now + the order-to-leaving target' })
  @IsOptional() @IsISO8601({ strict: true }) plannedLeaveAt?: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) diagnosis: string;
  @ApiPropertyOptional({ enum: CONDITIONS }) @IsOptional() @IsIn(CONDITIONS as readonly string[]) condition?: Condition;
  @ApiPropertyOptional({ description: 'Died only' }) @IsOptional() @IsISO8601({ strict: true }) timeOfDeath?: string;
  @ApiPropertyOptional({ description: 'Died only' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) causeOfDeath?: string;
  @ApiPropertyOptional({ description: 'Transfer only' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) receivingHospital?: string;
  @ApiPropertyOptional({ description: 'Transfer only' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) transferReason?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) note?: string;
  /**
   * "none", or { lines } validated nested (Task 8 M3): the service gets the checked copy, trimmed and whitelisted, never
   * the raw body. The same holds for the follow-up.
   */
  @ApiPropertyOptional({ description: '"none", or { lines }' })
  @IsOptional() @unlessNone('takeHome') @IsObject({ message: 'takeHome must be "none" or { lines: 1 to 10 medicines }' })
  @ValidateNested() @Type(() => TakeHomeDto) takeHome?: TakeHomeDto | 'none';
  @ApiPropertyOptional({ description: '"none", or { inDays, doctorId?, departmentCode?, note? }' })
  @IsOptional() @unlessNone('followUp') @IsObject({ message: 'followUp must be "none" or { inDays, doctorId?, departmentCode?, note? }' })
  @ValidateNested() @Type(() => FollowUpChoiceDto) followUp?: FollowUpChoiceDto | 'none';
}

/** `PATCH /discharge/orders/:id`: only what is sent changes. */
export class EditDischargeOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) plannedLeaveAt?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) diagnosis?: string;
  @ApiPropertyOptional({ enum: CONDITIONS }) @IsOptional() @IsIn(CONDITIONS as readonly string[]) condition?: Condition;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) note?: string;
  @ApiPropertyOptional({ type: TakeHomeDto }) @IsOptional() @ValidateNested() @Type(() => TakeHomeDto) takeHome?: TakeHomeDto;
  @ApiPropertyOptional({ type: FollowUpChoiceDto }) @IsOptional() @ValidateNested() @Type(() => FollowUpChoiceDto) followUp?: FollowUpChoiceDto;
}

/** Cancelling an order: 1 to 300 characters, kept on the order and never sent in a message. */
export class DischargeReasonDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
}

/** `POST /discharge/orders/check`: the live safety flags of take-home lines for the plan's patient. */
export class DischargeCheckDto {
  @ApiProperty() @IsMongoId() planId: string;
  @ApiProperty({ type: [LineDto] }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LineDto) lines: LineDto[];
}

/** `GET /discharge/queue`: every filter optional. */
export class DischargeQueueQueryDto {
  @ApiPropertyOptional({ description: "The ward's name, as the rows show it" }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) ward?: string;
  @ApiPropertyOptional({ description: "The admission's doctor, as the rows show it" }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) doctor?: string;
  @ApiPropertyOptional({ enum: ['due', ...SHOWN_STATUSES] }) @IsOptional() @IsIn(['due', ...SHOWN_STATUSES]) status?: string;
  @ApiPropertyOptional({ description: "Part of the patient's name or UHID, or of the bed label" }) @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
}

/** `PATCH /discharge/plans/:planId/target`: a day from today on (the service checks the day), and an optional note. */
export class DischargeTargetDto {
  @ApiProperty({ example: '2026-09-28' }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'targetDay must be a day as YYYY-MM-DD' }) targetDay: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

/** Who received the body (the body handover tick). */
export class BodyReceiverDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) name: string;
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(100) relationship: string;
}

/** `POST /discharge/orders/:id/lines/:key`: a hand line marked done, or a take-home or follow-up line marked not needed. */
export class DischargeTickDto {
  @ApiProperty({ enum: ['done', 'not-needed'] }) @IsIn(['done', 'not-needed']) state: 'done' | 'not-needed';
  @ApiPropertyOptional() @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
  @ApiPropertyOptional({ type: BodyReceiverDto, description: 'Body handed over only, required there' })
  @IsOptional() @ValidateNested() @Type(() => BodyReceiverDto) receiver?: BodyReceiverDto;
}

/**
 * `PUT /discharge/orders/:id/summary`: the changed sections (and the doctor's note as `note`), the course paragraph, and
 * `seen`, the summary's `updatedAt` as the editor loaded it (R38). The service checks the section keys and lengths.
 */
export class DischargeSummarySaveDto {
  @ApiPropertyOptional({ description: 'Section key to text' }) @IsOptional() @IsObject() sections?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsString() course?: string;
  /** R50: required on the HTTP body, so a doctor never saves over text they did not load (the service's own argument stays optional). */
  @ApiProperty({ description: "The summary's updatedAt as the editor loaded it" }) @IsISO8601() seen: string;
}

/** `POST /discharge/orders/:id/summary/sign`. R50: `seen` is required, so a doctor never signs text they did not see. */
export class DischargeSignDto {
  @ApiProperty({ description: "The summary's updatedAt as the editor loaded it" }) @IsISO8601() seen: string;
}

/** `POST /discharge/plans/:planId/left-without-discharge`. */
export class LeftWithoutDischargeDto {
  @ApiProperty() @Transform(trim) @IsString() @MinLength(1) @MaxLength(300) reason: string;
  @ApiProperty({ description: 'Clinic time, from the admission to now' }) @IsISO8601({ strict: true }) lastSeenAt: string;
}
