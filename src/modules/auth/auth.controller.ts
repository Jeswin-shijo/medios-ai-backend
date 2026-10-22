import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ClientHeaderGuard, CLIENT_HEADER } from '../../common/guards/client-header.guard';
import { UserRole } from '../users/schemas/user.schema';
import { ClientMeta } from './tokens.service';

const MINUTE = 60_000;

// Sessions: a short-lived access token (Authorization: Bearer) plus a rotating
// refresh token in an httpOnly cookie scoped to /api/auth, so page scripts can
// never read it.
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: 'Sign in; returns an access token and sets the refresh cookie' })
  @ApiResponse({ status: 200, description: 'Signed in' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many attempts or account temporarily locked' })
  async login(@Body() loginDto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { refreshToken, refreshExpiresAt, ...session } = await this.authService.login(loginDto, this.meta(req));
    this.setRefreshCookie(res, refreshToken, refreshExpiresAt);
    return session;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientHeaderGuard)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiHeader({ name: CLIENT_HEADER, required: true })
  @ApiOperation({ summary: 'Exchange the refresh cookie for a new access token (rotates the cookie)' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      const { refreshToken, refreshExpiresAt, ...session } = await this.authService.refresh(this.refreshCookie(req), this.meta(req));
      this.setRefreshCookie(res, refreshToken, refreshExpiresAt);
      return session;
    } catch (err) {
      this.clearRefreshCookie(res);
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ClientHeaderGuard)
  @ApiHeader({ name: CLIENT_HEADER, required: true })
  @ApiOperation({ summary: 'Sign out this device' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(this.refreshCookie(req));
    this.clearRefreshCookie(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out every device and revoke all issued tokens' })
  async logoutAll(@CurrentUser() user: any, @Res({ passthrough: true }) res: Response) {
    await this.authService.logoutAll(String(user._id));
    this.clearRefreshCookie(res);
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: "List the signed-in user's active sessions (devices)" })
  async sessions(@CurrentUser() user: any, @Req() req: Request) {
    return this.authService.listSessions(String(user._id), this.refreshCookie(req));
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign one of your sessions out' })
  async revokeSession(@CurrentUser() user: any, @Param('id') id: string) {
    await this.authService.revokeSession(String(user._id), id);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: MINUTE } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password; signs out all other sessions and returns a new one' })
  async changePassword(
    @CurrentUser() user: any,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { refreshToken, refreshExpiresAt, ...session } = await this.authService.changePassword(String(user._id), dto, this.meta(req));
    this.setRefreshCookie(res, refreshToken, refreshExpiresAt);
    return session;
  }

  @Post('register')
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a staff account (admins only)' })
  @ApiResponse({ status: 201, description: 'Account created' })
  @ApiResponse({ status: 403, description: 'Caller is not an admin' })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the signed-in user' })
  async getProfile(@CurrentUser() user: any) {
    return user;
  }

  private meta(req: Request): ClientMeta {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  private refreshCookie(req: Request): string | undefined {
    return req.cookies?.[this.config.get<string>('refreshToken.cookieName')];
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get<boolean>('refreshToken.cookieSecure'),
      sameSite: this.config.get<'lax' | 'strict' | 'none'>('refreshToken.cookieSameSite'),
      path: '/api/auth',
    };
  }

  private setRefreshCookie(res: Response, token: string, expires: Date) {
    res.cookie(this.config.get<string>('refreshToken.cookieName'), token, { ...this.cookieOptions(), expires });
  }

  private clearRefreshCookie(res: Response) {
    res.clearCookie(this.config.get<string>('refreshToken.cookieName'), this.cookieOptions());
  }
}
