import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AiService } from './ai.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';

const MINUTE = 60_000;

@ApiTags('AI')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  @ApiOperation({ summary: 'Which AI provider is active and which features are switched on' })
  status() {
    return this.ai.status();
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: 'Test the connection to the AI provider (admin)' })
  check() {
    return this.ai.check();
  }
}
