import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { NEEDS, Need, RoomClass } from '../bed-types';

/** Every room class a patient can be admitted to (isolation is a need, not a class). */
const ROOM_CLASSES: RoomClass[] = ['emergency', 'icu', 'hdu', 'general', 'paediatric', 'maternity', 'twin', 'private', 'deluxe'];

export class SuggestBedsDto {
  @ApiProperty({ description: 'The patient id or UHID' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  patientId: string;

  @ApiProperty({ enum: ROOM_CLASSES })
  @IsIn(ROOM_CLASSES)
  roomClass: RoomClass;

  @ApiProperty({ enum: NEEDS, isArray: true })
  @IsArray()
  @ArrayUnique()
  @IsIn(NEEDS, { each: true })
  needs: Need[];

  @ApiProperty({ example: 'General Medicine' })
  @IsString()
  @MaxLength(100)
  department: string;

  @ApiProperty({ example: 'Dr. Shajin' })
  @IsString()
  @MaxLength(100)
  doctor: string;

  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(1)
  @Max(90)
  expectedStayDays: number;

  @ApiProperty({ description: "The doctor's notes; may be empty" })
  @IsString()
  @MaxLength(4000, { message: "Doctor's notes can be at most 4,000 characters." })
  notes: string;

  @ApiPropertyOptional({ description: 'For a transfer: the bed the patient is in now' })
  @IsOptional()
  @IsMongoId()
  currentBedId?: string;
}

export class HoldBedDto {
  @ApiProperty()
  @IsMongoId()
  suggestionId: string;
}

export class AdmitBedDto {
  @ApiProperty()
  @IsMongoId()
  suggestionId: string;

  @ApiPropertyOptional({ description: 'Why not the top suggestion, or why the rules are ignored' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'Choose a bed the rules exclude (doctor or admin only)' })
  @IsOptional()
  @IsBoolean()
  ruleOverride?: boolean;

  @ApiPropertyOptional({ description: 'The bed request this admission answers; it closes with this choice' })
  @IsOptional()
  @IsMongoId()
  requestId?: string;
}

export class TransferBedDto extends AdmitBedDto {
  @ApiProperty({ description: 'The bed to move the patient to' })
  @IsMongoId()
  toBedId: string;
}

export class DischargeBedDto {
  @ApiPropertyOptional({ description: 'The admission staff saw in the bed; null or left out for a sample occupant', nullable: true })
  @IsOptional()
  @IsMongoId()
  admissionId?: string | null;
}

export class BlockBedDto {
  @ApiProperty({ example: 'Repairs: oxygen point' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;
}

const REQUEST_TYPES = ['admission', 'transfer'] as const;
const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const REQUEST_STATES = ['searching', 'assigned', 'waiting', 'attention', 'cancelled'] as const;

export class CreateBedRequestDto extends OmitType(SuggestBedsDto, ['currentBedId'] as const) {
  @ApiProperty({ enum: REQUEST_TYPES })
  @IsIn(REQUEST_TYPES)
  type: 'admission' | 'transfer';

  @ApiPropertyOptional({ description: 'For a transfer: the bed the patient is in now' })
  @ValidateIf((o) => o.type === 'transfer')
  @IsMongoId()
  fromBedId?: string;

  @ApiProperty({ enum: PRIORITIES })
  @IsIn(PRIORITIES)
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export class BedRequestQueryDto {
  @ApiPropertyOptional({ enum: REQUEST_STATES })
  @IsOptional()
  @IsIn(REQUEST_STATES)
  state?: (typeof REQUEST_STATES)[number];

  @ApiPropertyOptional({ enum: ['admission', 'transfer', 'step-down'] })
  @IsOptional()
  @IsIn(['admission', 'transfer', 'step-down'])
  type?: 'admission' | 'transfer' | 'step-down';

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ description: 'Only requests made before this time (ISO date)' })
  @IsOptional()
  @IsISO8601()
  before?: string;
}

export class RequestIdParam {
  @IsMongoId()
  id: string;
}

export class NotesNeedDto {
  @ApiProperty({ enum: NEEDS })
  @IsIn(NEEDS)
  need: Need;

  @ApiProperty({ description: 'true to add the need, false to dismiss it' })
  @IsBoolean()
  confirm: boolean;
}
