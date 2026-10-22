import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '../../users/schemas/user.schema';
import { IsAcceptablePassword } from './password-policy';

/** Admin-only account creation (POST /auth/register). */
export class RegisterDto {
  @ApiProperty({ example: 'Dr. Priya', description: 'Full name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: 'priya@medios.ai', description: 'Staff email (sign-in name)' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Str0ng!Passw0rd', description: '8–72 characters with upper and lower case, a number and a symbol' })
  @IsAcceptablePassword()
  password: string;

  @ApiPropertyOptional({ enum: UserRole, default: UserRole.STAFF })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ example: 'General Physician' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  specialty?: string;

  @ApiPropertyOptional({ example: 'General Medicine' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  department?: string;

  @ApiPropertyOptional({ example: '+91 98765 43210' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}
