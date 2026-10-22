import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UserDocument, UserRole } from '../users/schemas/user.schema';
import { ClientMeta, TokensService } from './tokens.service';

const INVALID_CREDENTIALS = 'Invalid email or password';

/** What clients may know about a user. */
const publicUser = (user: UserDocument) => ({
  id: String(user._id),
  email: user.email,
  name: user.name,
  specialty: user.specialty,
  department: user.department,
  doctorId: user.doctorId,
  avatar: user.avatar,
  phone: user.phone,
  role: user.role,
  lastLoginAt: user.lastLoginAt,
  passwordChangedAt: user.passwordChangedAt,
});

@Injectable()
export class AuthService {
  /** Compared against when the email is unknown, so response time does not reveal which emails exist. */
  private readonly dummyHash: string;

  constructor(
    private usersService: UsersService,
    private tokensService: TokensService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {
    this.dummyHash = bcrypt.hashSync('timing-equaliser', this.bcryptRounds);
  }

  private get bcryptRounds() {
    return this.config.get<number>('security.bcryptRounds');
  }

  async login(loginDto: LoginDto, meta: ClientMeta) {
    const user = await this.usersService.findByEmailForLogin(loginDto.email);
    if (!user || !user.isActive) {
      await bcrypt.compare(loginDto.password, this.dummyHash);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new HttpException(
        `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!(await bcrypt.compare(loginDto.password, user.passwordHash))) {
      await this.recordFailedLogin(user);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    await user.save();
    return this.startSession(user, meta);
  }

  /** Exchanges the refresh cookie for a new access token (and a rotated cookie). */
  async refresh(refreshToken: string | undefined, meta: ClientMeta) {
    if (!refreshToken) throw new UnauthorizedException('Not signed in');
    const rotated = await this.tokensService.rotate(refreshToken, meta);
    const user = await this.usersService.findByIdForAuth(rotated.userId);
    if (!user || !user.isActive) {
      await this.tokensService.revokeSession(rotated.refreshToken);
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }
    return {
      ...this.accessTokenFor(user),
      user: publicUser(user),
      refreshToken: rotated.refreshToken,
      refreshExpiresAt: rotated.expiresAt,
    };
  }

  /** Ends this device's session. */
  async logout(refreshToken: string | undefined) {
    if (refreshToken) await this.tokensService.revokeSession(refreshToken);
  }

  /** Ends every session and invalidates all access tokens already issued. */
  async logoutAll(userId: string) {
    await this.usersService.bumpTokenVersion(userId);
    await this.tokensService.revokeAllForUser(userId);
  }

  listSessions(userId: string, refreshToken: string | undefined) {
    return this.tokensService.listSessions(userId, refreshToken);
  }

  revokeSession(userId: string, sessionId: string) {
    return this.tokensService.revokeSessionForUser(userId, sessionId);
  }

  /** Signs out every other session; the caller gets a fresh one. */
  async changePassword(userId: string, dto: ChangePasswordDto, meta: ClientMeta) {
    const user = await this.usersService.findByIdWithPassword(userId);
    if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (await bcrypt.compare(dto.newPassword, user.passwordHash)) {
      throw new BadRequestException('Choose a password different from the current one');
    }

    user.passwordHash = await bcrypt.hash(dto.newPassword, this.bcryptRounds);
    user.passwordChangedAt = new Date();
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();
    await this.tokensService.revokeAllForUser(userId);
    return this.startSession(user, meta);
  }

  /** Admin-only: creates a staff account. The new user signs in themselves. */
  async register(registerDto: RegisterDto) {
    const newUser = await this.usersService.create({
      name: registerDto.name,
      email: registerDto.email,
      passwordHash: await bcrypt.hash(registerDto.password, this.bcryptRounds),
      role: registerDto.role ?? UserRole.STAFF,
      specialty: registerDto.specialty ?? '',
      department: registerDto.department ?? '',
      phone: registerDto.phone ?? '',
      passwordChangedAt: new Date(),
    });
    return publicUser(newUser);
  }

  private async startSession(user: UserDocument, meta: ClientMeta) {
    const session = await this.tokensService.createSession(user._id as any, meta);
    return {
      ...this.accessTokenFor(user),
      user: publicUser(user),
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.expiresAt,
    };
  }

  private accessTokenFor(user: UserDocument) {
    const accessToken = this.tokensService.signAccessToken(user);
    const { exp, iat } = this.jwtService.decode(accessToken) as { exp: number; iat: number };
    return { accessToken, expiresIn: exp - iat };
  }

  /** Counts a failed password; enough of them in a row lock the account for a while. */
  private async recordFailedLogin(user: UserDocument) {
    const attempts = (user.failedLoginAttempts ?? 0) + 1;
    const max = this.config.get<number>('security.maxFailedLogins');
    if (attempts >= max) {
      const minutes = this.config.get<number>('security.lockoutMinutes');
      user.failedLoginAttempts = 0;
      user.lockedUntil = new Date(Date.now() + minutes * 60_000);
    } else {
      user.failedLoginAttempts = attempts;
    }
    await user.save();
  }
}
