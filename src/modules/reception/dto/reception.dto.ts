import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PAYMENT_METHODS, PaymentMethod } from '../schemas/op-visit.schema';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_MAX = 200;

export class CardDto {
  @ApiProperty({ example: '04A1B2C3' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  cardId: string;
}

export class SendOtpDto {
  @ApiProperty({ example: '98765 43210' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;
}

export class VerifyOtpDto extends SendOtpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'The code is 6 digits' })
  code: string;
}

export class RegisterDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  name: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone: string;

  @ApiProperty({ enum: ['Male', 'Female', 'Other'] })
  @IsIn(['Male', 'Female', 'Other'])
  gender: 'Male' | 'Female' | 'Other';

  @ApiPropertyOptional({ description: 'Whole years; required unless dob is given' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  age?: number;

  @ApiPropertyOptional({ example: '1990-04-23' })
  @IsOptional()
  @IsString()
  @Matches(ISO_DAY, { message: 'dob must be YYYY-MM-DD' })
  dob?: string;

  @ApiPropertyOptional({ description: 'Register a new person although the number already has records' })
  @IsOptional()
  @IsBoolean()
  confirmNew?: boolean;
}

export class CreateVisitDto {
  @ApiProperty({ description: 'The session from a card tap, code check or registration' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SESSION_MAX)
  session: string;

  @ApiProperty()
  @IsMongoId()
  doctorId: string;
}

export class PayDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS as unknown as string[])
  method: PaymentMethod;
}

export class DoctorsQueryDto {
  @ApiPropertyOptional({ description: 'Department code' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  department?: string;
}

export class VisitsQueryDto {
  @ApiPropertyOptional({ enum: ['awaiting-cash', 'paid', 'needs-attention', 'all'] })
  @IsOptional()
  @IsIn(['awaiting-cash', 'paid', 'needs-attention', 'all'])
  status?: 'awaiting-cash' | 'paid' | 'needs-attention' | 'all';

  @ApiPropertyOptional({ example: '2026-09-26' })
  @IsOptional()
  @IsString()
  @Matches(ISO_DAY, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
