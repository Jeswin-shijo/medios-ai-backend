import { Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'crypto';
import { CallsService } from './calls.service';
import { AGENT_SCRIPTS } from './agent-scripts';
import { BookingCallDto, ConfirmationCallDto, ListCallsQueryDto, SlotsQueryDto } from './dto/call-requests.dto';
import { parseSnapServeResult } from './providers/snapserve.provider';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/schemas/user.schema';

const MINUTE = 60_000;

/** Constant-time comparison of a presented secret with the configured one. */
const sameSecret = (presented: string, expected: string) => {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return !!expected && timingSafeEqual(digest(presented), digest(expected));
};

@ApiTags('AI Call Agent')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Call log, newest first (transcripts omitted)' })
  list(@Query() query: ListCallsQueryDto) {
    return this.calls.list(query);
  }

  @Get('stats')
  @ApiOperation({ summary: "Today's call counts and appointments needing attention" })
  stats() {
    return this.calls.stats();
  }

  @Get('config')
  @ApiOperation({ summary: 'Which voice provider is active and the effective agent settings' })
  async getConfig() {
    return { ...this.calls.providerInfo, settings: await this.calls.agentSettings() };
  }

  @Get('scripts')
  @ApiOperation({ summary: "The voice agents' scripts, outcomes and data fields (to set up the provider's agents)" })
  scripts() {
    return Object.values(AGENT_SCRIPTS);
  }

  @Get('slots')
  @ApiOperation({ summary: 'Free slots the booking agent would offer' })
  @ApiQuery({ name: 'from', required: false, description: 'YYYY-MM-DD (default now)' })
  slots(@Query() query: SlotsQueryDto) {
    return this.calls.freeSlots(query.from, query.count);
  }

  @Post('confirmation')
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: 'Call a patient to confirm a scheduled appointment (queued until calling hours if outside them)' })
  confirm(@Body() dto: ConfirmationCallDto, @CurrentUser('name') user: string) {
    return this.calls.requestConfirmation(dto.appointmentId, user || 'Staff');
  }

  @Post('booking')
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: 'Call a patient to book an appointment in one of two free slots' })
  book(@Body() dto: BookingCallDto, @CurrentUser('name') user: string) {
    return this.calls.requestBooking(dto, user || 'Staff');
  }

  @Post('run-due')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run the scheduler now: queue automatic confirmations and place due calls' })
  runDue() {
    return this.calls.runDue();
  }

  @Delete('do-not-call/:uhid')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @ApiOperation({ summary: 'Allow the AI agent to call a patient again' })
  allowCalls(@Param('uhid') uhid: string) {
    return this.calls.allowCalls(uhid);
  }

  /**
   * Post-call results from the voice provider. Server-to-server, so no user token:
   * the provider is given this URL with ?token=CALL_WEBHOOK_SECRET.
   */
  @Public()
  @Post('webhook/:provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Voice provider post-call webhook (authenticated by ?token=)' })
  async webhook(@Param('provider') provider: string, @Query('token') token: string, @Body() body: unknown) {
    if (provider !== 'snapserve' || this.calls.providerInfo.provider !== 'snapserve') throw new NotFoundException();
    if (!sameSecret(String(token ?? ''), this.config.get<string>('callAgent.webhookSecret') ?? '')) {
      throw new UnauthorizedException('Invalid webhook token');
    }
    return this.calls.recordResult(parseSnapServeResult(body));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One call with its transcript' })
  findOne(@Param('id') id: string) {
    return this.calls.findOne(id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a call that has not been placed yet' })
  cancel(@Param('id') id: string, @CurrentUser('name') user: string) {
    return this.calls.cancel(id, user || 'Staff');
  }
}
