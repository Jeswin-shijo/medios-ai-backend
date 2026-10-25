import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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
}

export class TransferBedDto extends AdmitBedDto {
  @ApiProperty({ description: 'The bed to move the patient to' })
  @IsMongoId()
  toBedId: string;
}

export class BlockBedDto {
  @ApiProperty({ example: 'Repairs: oxygen point' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;
}
