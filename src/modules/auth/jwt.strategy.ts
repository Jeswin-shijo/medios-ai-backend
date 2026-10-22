import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { AccessTokenPayload } from './tokens.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('jwt.secret'),
      issuer: configService.get<string>('jwt.issuer'),
      audience: configService.get<string>('jwt.audience'),
      algorithms: ['HS256'],
    });
  }

  /** Signature, expiry, issuer and audience are already verified; check the user is still allowed in. */
  async validate(payload: AccessTokenPayload) {
    const user = await this.usersService.findByIdForAuth(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User no longer exists or has been deactivated');
    }
    // Logout-all and password changes bump tokenVersion, retiring older tokens.
    if ((user.tokenVersion ?? 0) !== payload.ver) {
      throw new UnauthorizedException('Session has been revoked. Please sign in again.');
    }
    return user;
  }
}
