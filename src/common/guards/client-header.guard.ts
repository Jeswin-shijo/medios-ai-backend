import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

export const CLIENT_HEADER = 'x-medios-client';

/**
 * CSRF protection for endpoints authenticated by the refresh cookie. Browsers will
 * not send a custom header cross-site without a CORS preflight, which only the
 * allowed origins pass, so a forged form post or link cannot use the cookie.
 */
@Injectable()
export class ClientHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest().headers[CLIENT_HEADER];
    if (!header) throw new ForbiddenException(`Missing ${CLIENT_HEADER} header`);
    return true;
  }
}
