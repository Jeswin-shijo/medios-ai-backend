import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { TokensService } from './tokens.service';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema';

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    MongooseModule.forFeature([{ name: RefreshToken.name, schema: RefreshTokenSchema }]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const issuer = configService.get<string>('jwt.issuer');
        const audience = configService.get<string>('jwt.audience');
        return {
          secret: configService.getOrThrow<string>('jwt.secret'),
          signOptions: {
            algorithm: 'HS256',
            expiresIn: configService.get<string>('jwt.accessTtl') as any,
            issuer,
            audience,
          },
          verifyOptions: { algorithms: ['HS256'], issuer, audience },
        };
      },
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokensService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
