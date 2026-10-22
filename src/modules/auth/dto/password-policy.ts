import { applyDecorators } from '@nestjs/common';
import { IsString, IsStrongPassword, MaxLength } from 'class-validator';

/**
 * Password rules for new passwords: at least 8 characters with upper and lower
 * case, a digit and a symbol. 72 is bcrypt's input limit; longer input would be
 * silently truncated.
 */
export const IsAcceptablePassword = () =>
  applyDecorators(
    IsString(),
    MaxLength(72, { message: 'Password must be at most 72 characters' }),
    IsStrongPassword(
      { minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
      { message: 'Password must be at least 8 characters with upper and lower case letters, a number and a symbol' },
    ),
  );
