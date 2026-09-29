import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { UserDocument } from '../users/schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  async validateUser(email: string, pass: string): Promise<UserDocument> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const isMatch = await bcrypt.compare(pass, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return user;
  }

  async login(loginDto: LoginDto) {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    const payload = { sub: user._id.toString(), email: user.email, role: user.role };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        specialty: user.specialty,
        department: user.department,
        doctorId: user.doctorId,
        avatar: user.avatar,
        phone: user.phone,
        role: user.role,
      },
    };
  }

  async register(registerDto: RegisterDto) {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(registerDto.password, salt);

    const newUser = await this.usersService.create({
      name: registerDto.name,
      email: registerDto.email,
      passwordHash,
      specialty: registerDto.specialty || 'General Physician',
      department: registerDto.department || 'OPD / General Medicine',
      phone: registerDto.phone || '+91 98765 43210',
    });

    const payload = { sub: newUser._id.toString(), email: newUser.email, role: newUser.role };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      user: {
        id: newUser._id,
        email: newUser.email,
        name: newUser.name,
        specialty: newUser.specialty,
        department: newUser.department,
        doctorId: newUser.doctorId,
        avatar: newUser.avatar,
        phone: newUser.phone,
        role: newUser.role,
      },
    };
  }
}
