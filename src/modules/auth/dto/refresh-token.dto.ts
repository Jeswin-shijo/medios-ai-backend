import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Native apps send their refresh token in the body; browsers use the cookie. */
export class RefreshTokenDto {
  @ApiPropertyOptional({ description: 'Native apps only (X-MediOS-Client: mobile)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}
