import { IsArray, IsEmail, IsNotEmpty, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePatientDto {
  @ApiPropertyOptional({ example: 'MHK202500321', description: 'Assigned by the server when omitted' })
  @IsOptional()
  @IsString()
  uhid?: string;

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

  @ApiPropertyOptional({ example: '12 Mar 1991' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  dob?: string;

  @ApiPropertyOptional({ example: '12, MG Road, Nagercoil' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ example: 'arun@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: 'Priya Kumar (wife) +91 98765 11111' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  emergencyContact?: string;

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

  @ApiPropertyOptional({ example: 'Dr. Shajin', description: 'Primary doctor; defaults to the signed-in user' })
  @IsOptional()
  @IsString()
  doctor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatar?: string;

  @ApiPropertyOptional({ example: '26 Sep 2026 09:15 AM' })
  @IsOptional()
  @IsString()
  lastVisit?: string;

  @ApiPropertyOptional({ example: '10 Oct 2026 10:30 AM' })
  @IsOptional()
  @IsString()
  nextAppointment?: string;

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
