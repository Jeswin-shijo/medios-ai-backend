import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema';
import { UserDocument } from '../users/schemas/user.schema';

/** Claims carried by an access token. `ver` must match the user's tokenVersion. */
export interface AccessTokenPayload {
  sub: string;
  role: string;
  ver: number;
}

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

/**
 * Two parallel requests (e.g. two tabs waking up) can present the same refresh
 * token; the loser of that race is rejected but does not count as theft.
 */
const ROTATION_GRACE_MS = 10_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @InjectModel(RefreshToken.name) private readonly refreshModel: Model<RefreshTokenDocument>,
  ) {}

  /** Short-lived bearer token for API calls. */
  signAccessToken(user: UserDocument): string {
    const payload: AccessTokenPayload = { sub: String(user._id), role: user.role, ver: user.tokenVersion ?? 0 };
    return this.jwtService.sign(payload, { jwtid: randomUUID() });
  }

  /** Starts a new sign-in session (a new token family). Returns the raw token for the cookie. */
  async createSession(userId: Types.ObjectId | string, meta: ClientMeta) {
    return this.issueRefreshToken(String(userId), randomUUID(), meta);
  }

  /**
   * Exchanges a refresh token for a new one in the same family. A token that was
   * already rotated (outside the grace window) means it was copied: the whole
   * family is revoked so neither copy works any more.
   */
  async rotate(rawToken: string, meta: ClientMeta) {
    const tokenHash = sha256(rawToken);
    const now = new Date();
    const next = this.newToken();

    // Atomically claim the token so concurrent rotations cannot both succeed.
    const current = await this.refreshModel
      .findOneAndUpdate(
        { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
        { revokedAt: now, replacedBy: next.hash },
      )
      .exec();

    if (!current) {
      const known = await this.refreshModel.findOne({ tokenHash }).exec();
      if (known?.revokedAt && known.replacedBy) {
        const sinceRotation = now.getTime() - known.revokedAt.getTime();
        if (sinceRotation > ROTATION_GRACE_MS) {
          await this.revokeFamily(known.family);
          this.logger.warn(`Refresh token reuse detected for user ${known.userId}; session family revoked`);
        }
      }
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    const created = await this.storeRefreshToken(String(current.userId), current.family, next, meta);
    return { userId: String(current.userId), ...created };
  }

  /** Ends the sign-in session the token belongs to. */
  async revokeSession(rawToken: string): Promise<void> {
    const token = await this.refreshModel.findOne({ tokenHash: sha256(rawToken) }).exec();
    if (token) await this.revokeFamily(token.family);
  }

  /** Ends every session of the user (all devices). */
  async revokeAllForUser(userId: Types.ObjectId | string): Promise<void> {
    await this.refreshModel
      .updateMany({ userId: new Types.ObjectId(String(userId)), revokedAt: null }, { revokedAt: new Date() })
      .exec();
  }

  /**
   * The user's signed-in devices: each live family has exactly one unrevoked token,
   * created at its last refresh. `current` marks the session making the request.
   */
  async listSessions(userId: string, currentRawToken?: string) {
    const currentHash = currentRawToken ? sha256(currentRawToken) : '';
    const tokens = await this.refreshModel
      .find({ userId: new Types.ObjectId(userId), revokedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ createdAt: -1 })
      .exec();
    return tokens.map((t) => ({
      id: t.family,
      lastActiveAt: (t as any).createdAt as Date,
      expiresAt: t.expiresAt,
      userAgent: t.userAgent,
      ip: t.ip,
      current: t.tokenHash === currentHash,
    }));
  }

  /** Signs one of the user's devices out. */
  async revokeSessionForUser(userId: string, family: string): Promise<void> {
    await this.refreshModel
      .updateMany({ userId: new Types.ObjectId(userId), family, revokedAt: null }, { revokedAt: new Date() })
      .exec();
  }

  private async revokeFamily(family: string): Promise<void> {
    await this.refreshModel.updateMany({ family, revokedAt: null }, { revokedAt: new Date() }).exec();
  }

  private newToken() {
    const raw = randomBytes(48).toString('base64url');
    return { raw, hash: sha256(raw) };
  }

  private async issueRefreshToken(userId: string, family: string, meta: ClientMeta) {
    return this.storeRefreshToken(userId, family, this.newToken(), meta);
  }

  private async storeRefreshToken(userId: string, family: string, token: { raw: string; hash: string }, meta: ClientMeta) {
    const ttlDays = this.config.get<number>('refreshToken.ttlDays');
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await this.refreshModel.create({
      userId: new Types.ObjectId(userId),
      tokenHash: token.hash,
      family,
      expiresAt,
      userAgent: (meta.userAgent ?? '').slice(0, 300),
      ip: meta.ip ?? '',
    });
    return { refreshToken: token.raw, expiresAt };
  }
}
