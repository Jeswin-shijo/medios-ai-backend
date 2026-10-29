import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

const PREFIX = /^[A-Z0-9]{1,3}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateDepartmentDto {
  @IsString() @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: 'code must be kebab-case' }) @MaxLength(40)
  code: string;

  @IsString() @IsNotEmpty() @MaxLength(60)
  name: string;

  @IsString() @Matches(PREFIX, { message: 'tokenPrefix must be 1-3 characters of A-Z or 0-9' })
  tokenPrefix: string;

  @IsString() @IsNotEmpty() @MaxLength(40)
  icon: string;

  @IsString() @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must look like #1D6FE0' })
  color: string;

  @IsInt() @Min(0) @Max(1000)
  order: number;

  @IsBoolean()
  active: boolean;
}

/** Everything but `code` may change after creation (the code is how doctors refer to it). */
export class UpdateDepartmentDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) name?: string;
  @IsOptional() @IsString() @Matches(PREFIX, { message: 'tokenPrefix must be 1-3 characters of A-Z or 0-9' }) tokenPrefix?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) icon?: string;
  @IsOptional() @IsString() @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'color must look like #1D6FE0' }) color?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) order?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class OpSessionDto {
  @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true })
  days: number[];

  @IsString() @Matches(TIME, { message: 'start must be HH:mm' })
  start: string;

  @IsString() @Matches(TIME, { message: 'end must be HH:mm' })
  end: string;
}

export class CreateDoctorDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsString() @MaxLength(120) qualifications: string;
  @IsString() @IsNotEmpty() @MaxLength(40) departmentCode: string;
  @IsInt() @Min(0) @Max(100000) fee: number;
  @IsString() @IsNotEmpty() @MaxLength(40) room: string;
  @IsString() @Matches(PREFIX, { message: 'tokenPrefix must be 1-3 characters of A-Z or 0-9' }) tokenPrefix: string;

  @IsArray() @ArrayMaxSize(21) @ValidateNested({ each: true }) @Type(() => OpSessionDto)
  sessions: OpSessionDto[];

  @IsOptional() @IsInt() @Min(3) @Max(60) avgConsultMinutes?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(40) userId?: string;
}

export class UpdateDoctorDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(120) qualifications?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) departmentCode?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100000) fee?: number;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) room?: string;
  @IsOptional() @IsString() @Matches(PREFIX, { message: 'tokenPrefix must be 1-3 characters of A-Z or 0-9' }) tokenPrefix?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(21) @ValidateNested({ each: true }) @Type(() => OpSessionDto)
  sessions?: OpSessionDto[];

  @IsOptional() @IsInt() @Min(3) @Max(60) avgConsultMinutes?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(40) userId?: string;
}

export class DoctorsQueryDto {
  @ApiPropertyOptional({ description: 'Department code' })
  @IsOptional() @IsString() @MaxLength(40)
  department?: string;

  @ApiPropertyOptional({ description: '"true" lists only active doctors' })
  @IsOptional() @IsString() @Matches(/^(true|false)$/)
  active?: string;
}

export class DepartmentsQueryDto {
  @ApiPropertyOptional({ description: '"true" lists only active departments' })
  @IsOptional() @IsString() @Matches(/^(true|false)$/)
  active?: string;
}

export class SuggestPrefixQueryDto {
  @IsString() @IsNotEmpty() @MaxLength(40)
  department: string;
}

export type DepartmentInput = CreateDepartmentDto;
export type DoctorInput = CreateDoctorDto;
