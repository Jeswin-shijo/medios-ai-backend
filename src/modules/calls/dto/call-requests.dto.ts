import { IsIn, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CALL_OUTCOMES, CALL_PURPOSES, CALL_STATUSES } from '../schemas/agent-call.schema';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ConfirmationCallDto {
  @ApiProperty({ description: 'The scheduled appointment to confirm' })
  @IsMongoId()
  appointmentId: string;
}

export class BookingCallDto {
  @ApiProperty({ example: 'MHK202500322' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  uhid: string;

  @ApiPropertyOptional({ example: 'Thyroid review with TSH results', description: 'Said to the patient as the reason for the visit' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  visitReason?: string;

  @ApiPropertyOptional({ example: 'Follow-up', default: 'Follow-up' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  appointmentType?: string;

  @ApiPropertyOptional({ example: '2026-09-28', description: 'Earliest day to offer (YYYY-MM-DD)' })
  @IsOptional()
  @Matches(ISO_DAY, { message: 'fromDate must be YYYY-MM-DD' })
  fromDate?: string;

  @ApiPropertyOptional({ description: 'Follow-up item this booking fulfils; it is updated with the booked slot' })
  @IsOptional()
  @IsMongoId()
  followUpId?: string;
}

export class ListCallsQueryDto {
  @IsOptional()
  @IsIn(CALL_PURPOSES)
  purpose?: string;

  @IsOptional()
  @IsIn(CALL_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(CALL_OUTCOMES)
  outcome?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  uhid?: string;

  @IsOptional()
  @IsMongoId()
  appointmentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class SlotsQueryDto {
  @IsOptional()
  @Matches(ISO_DAY, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(6)
  count?: number;
}
