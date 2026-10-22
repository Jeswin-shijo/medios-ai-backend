import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsAcceptablePassword } from './password-policy';

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({ description: '8–72 characters with upper and lower case, a number and a symbol' })
  @IsAcceptablePassword()
  newPassword: string;
}
