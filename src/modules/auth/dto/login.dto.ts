import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'doctor@medios.ai', description: 'User email' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  // No policy check here: existing passwords predate the policy. The length cap
  // keeps oversized inputs away from bcrypt.
  @ApiProperty({ example: 'Admin@123', description: 'User password' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
