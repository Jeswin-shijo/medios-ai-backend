import { Injectable, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<UserDocument>,
  ) {}

  async findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  /** For sign-in only: includes the password hash and lockout state. */
  async findByEmailForLogin(email: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ email: email.toLowerCase() })
      .select('+passwordHash +failedLoginAttempts +lockedUntil +tokenVersion')
      .exec();
  }

  /** For token checks: includes the token version that revokes old access tokens. */
  async findByIdForAuth(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).select('+tokenVersion').exec();
  }

  /** For password changes: includes the current hash. */
  async findByIdWithPassword(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).select('+passwordHash +tokenVersion').exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  async create(data: Partial<User>): Promise<UserDocument> {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }
    const created = new this.userModel(data);
    return created.save();
  }

  async updateProfile(id: string, updates: Partial<User>): Promise<UserDocument | null> {
    return this.userModel.findByIdAndUpdate(id, updates, { new: true }).exec();
  }

  /** Invalidates every access token issued to the user so far. */
  async bumpTokenVersion(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } }).exec();
  }

  async count(): Promise<number> {
    return this.userModel.countDocuments().exec();
  }
}
