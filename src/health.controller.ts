import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { SkipThrottle } from '@nestjs/throttler';
import { Connection } from 'mongoose';
import { Public } from './common/decorators/public.decorator';

/** Health check for the host (Render polls GET /api/health): up and connected to MongoDB. */
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Public()
  @SkipThrottle()
  @Get()
  check() {
    // 1 = connected. While MongoDB is unreachable the host keeps the previous deploy serving.
    if (this.connection.readyState !== 1) throw new ServiceUnavailableException('Database not connected');
    return { status: 'ok' };
  }
}
