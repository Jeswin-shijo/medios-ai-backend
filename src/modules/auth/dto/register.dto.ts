import { IsEmail, IsNotEmpty, IsOptional, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'Dr. Shajin', description: 'Full name' })
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'doctor@medios.ai', description: 'Doctor/Staff email' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'Admin@123', description: 'Password (min 6 characters)' })
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @ApiPropertyOptional({ example: 'General Physician' })
  @IsOptional()
  specialty?: string;

  @ApiPropertyOptional({ example: 'OPD / General Medicine' })
  @IsOptional()
  department?: string;

  @ApiPropertyOptional({ example: '+91 98765 43210' })
  @IsOptional()
  phone?: string;
}
