import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { COLOUR_RANK, COMPLAINTS, PATHWAYS } from '../er-rules';
import { ER_BAY_KINDS } from '../schemas/er-bay.schema';
import { ER_DISPOSITIONS, ER_MODES } from '../schemas/er-visit.schema';

const COLOURS = Object.keys(COLOUR_RANK);
const COMPLAINT_KEYS = COMPLAINTS.map((c) => c.key);
const GENDERS = ['Male', 'Female', 'Other'];
const STEP_KEYS = [...new Set(Object.values(PATHWAYS).flatMap((p) => p.steps.map((s) => s.key)))].filter((k) => k !== 'doctor');

export class IdParam {
  @IsMongoId()
  id: string;
}

export class PathwayParam extends IdParam {
  @IsIn(Object.keys(PATHWAYS))
  key: string;
}

export class StepParam extends IdParam {
  @IsIn(STEP_KEYS, { message: `step must be one of ${STEP_KEYS.join(', ')}` })
  step: string;
}

/** Vital signs as the triage form sends them; every reading is optional. */
export class VitalsDto {
  @ApiPropertyOptional({ example: 96 }) @IsOptional() @IsNumber() @Min(50) @Max(100) spo2?: number;
  @ApiPropertyOptional({ example: 120 }) @IsOptional() @IsNumber() @Min(40) @Max(300) bpSystolic?: number;
  @ApiPropertyOptional({ example: 80 }) @IsOptional() @IsNumber() @Min(20) @Max(200) bpDiastolic?: number;
  @ApiPropertyOptional({ example: 80 }) @IsOptional() @IsNumber() @Min(20) @Max(250) heartRate?: number;
  @ApiPropertyOptional({ example: 16 }) @IsOptional() @IsNumber() @Min(4) @Max(80) respiratoryRate?: number;
  @ApiPropertyOptional({ example: 37 }) @IsOptional() @IsNumber() @Min(30) @Max(45) temperature?: number;
}

export class EmergencyDto {
  @ApiProperty({ enum: GENDERS }) @IsIn(GENDERS) gender: 'Male' | 'Female' | 'Other';
  @ApiProperty({ minimum: 0, maximum: 120 }) @IsInt() @Min(0) @Max(120) approxAge: number;
  @ApiProperty({ description: 'What staff can use to recognise the patient' }) @IsString() @IsNotEmpty() @MaxLength(200) description: string;
}

@ValidatorConstraint({ name: 'exactlyOneWay', async: false })
class ExactlyOneWay implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments) {
    const o = args.object as Record<string, unknown>;
    return ['patientId', 'uhid', 'cardId', 'emergency'].filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').length === 1;
  }
  defaultMessage() {
    return 'Give exactly one of patientId, uhid, cardId or emergency';
  }
}

export class ArrivalDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() patientId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) uhid?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) cardId?: string;
  @ApiPropertyOptional({ type: EmergencyDto }) @IsOptional() @ValidateNested() @Type(() => EmergencyDto) emergency?: EmergencyDto;

  /** Carries the "exactly one of the four" check, because it always runs. */
  @ApiProperty({ enum: ER_MODES })
  @IsIn(ER_MODES as readonly string[])
  @Validate(ExactlyOneWay)
  mode: (typeof ER_MODES)[number];

  @ApiProperty({ enum: COMPLAINT_KEYS }) @IsIn(COMPLAINT_KEYS) complaint: (typeof COMPLAINTS)[number]['key'];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) complaintText?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() expectedId?: string;
}

export class ExpectedDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) complaint: string;
  @ApiProperty({ example: '45 M', description: 'Age and sex as the caller gave them; the card needs it' }) @IsString() @IsNotEmpty() @MaxLength(40) ageSex: string;
  @ApiProperty({ enum: ER_MODES }) @IsIn(ER_MODES as readonly string[]) mode: (typeof ER_MODES)[number];
  @ApiProperty({ minimum: 1, maximum: 240 }) @IsInt() @Min(1) @Max(240) etaMinutes: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() patientId?: string;
}

/** What the rules need to suggest a colour. The reasons are never taken from the client. */
export class TriageSuggestDto {
  @ApiProperty({ enum: COMPLAINT_KEYS }) @IsIn(COMPLAINT_KEYS) complaint: (typeof COMPLAINTS)[number]['key'];
  @ApiPropertyOptional({ type: VitalsDto }) @IsOptional() @ValidateNested() @Type(() => VitalsDto) vitals?: VitalsDto;
  @ApiPropertyOptional({ minimum: 0, maximum: 10 }) @IsOptional() @IsInt() @Min(0) @Max(10) painScore?: number;
}

export class TriageDto extends TriageSuggestDto {
  @ApiProperty({ enum: COLOURS }) @IsIn(COLOURS) colour: 'red' | 'orange' | 'yellow' | 'green';
  @ApiPropertyOptional({ description: 'Required by the service when the colour is lower than suggested' })
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class RetriageDto {
  @ApiProperty({ enum: COLOURS }) @IsIn(COLOURS) colour: 'red' | 'orange' | 'yellow' | 'green';
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

export class CancelPathwayDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

export class BayAssignDto {
  @ApiProperty({ nullable: true, description: 'The bay id, or null to take the patient out of the bay' })
  @ValidateIf((o) => o.bayId !== null)
  @IsMongoId()
  bayId: string | null;
}

export class BayQueryDto {
  @ApiProperty({ enum: COLOURS }) @IsIn(COLOURS) colour: 'red' | 'orange' | 'yellow' | 'green';
}

export class DispositionDto {
  @ApiProperty({ enum: ER_DISPOSITIONS }) @IsIn(ER_DISPOSITIONS as readonly string[]) kind: (typeof ER_DISPOSITIONS)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

export class HandoverDto {
  @ApiProperty() @IsString() @MaxLength(2000) note: string;
}

export class SnapshotQueryDto {
  @ApiPropertyOptional({ enum: ['24h', '7d'], default: '24h' }) @IsOptional() @IsIn(['24h', '7d']) range?: '24h' | '7d';
}

export class BayDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() id?: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(40) name: string;
  @ApiProperty({ enum: ER_BAY_KINDS }) @IsIn(ER_BAY_KINDS as readonly string[]) kind: (typeof ER_BAY_KINDS)[number];
  @ApiProperty() @IsBoolean() outOfUse: boolean;
}
