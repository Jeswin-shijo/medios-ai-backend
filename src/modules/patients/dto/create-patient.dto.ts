import { IsNotEmpty, IsNumber, IsOptional, IsString, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePatientDto {
  @ApiProperty({ example: 'MHK202500321' })
  @IsNotEmpty()
  @IsString()
  uhid: string;

  @ApiProperty({ example: 'Arun Kumar' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ example: 45 })
  @IsNotEmpty()
  @IsNumber()
  age: number;

  @ApiProperty({ example: 'Male' })
  @IsNotEmpty()
  @IsString()
  gender: string;

  @ApiProperty({ example: '+91 98401 23456' })
  @IsNotEmpty()
  @IsString()
  phone: string;

  @ApiPropertyOptional({ example: 'B+' })
  @IsOptional()
  @IsString()
  bloodGroup?: string;

  @ApiPropertyOptional({ example: 'OPD' })
  @IsOptional()
  @IsString()
  visitType?: string;

  @ApiPropertyOptional({ example: 'Today' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ example: 'General Medicine' })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({ example: ['Type 2 Diabetes', 'Hypertension'] })
  @IsOptional()
  @IsArray()
  conditions?: string[];

  @ApiPropertyOptional({ example: ['Penicillin'] })
  @IsOptional()
  @IsArray()
  allergies?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  insurance?: any;

  @ApiPropertyOptional()
  @IsOptional()
  vitals?: any;

  @ApiPropertyOptional()
  @IsOptional()
  aiSummary?: any;
}
