import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, RawBodyRequest, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'crypto';
import { CallsService } from './calls.service';
import { InboundService, ToolContext } from './inbound.service';
import { BookingCallDto, ConfirmationCallDto, ListCallsQueryDto, SlotsQueryDto } from './dto/call-requests.dto';
import { parseSnapServeResult, validSnapServeSignature } from './providers/snapserve.provider';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserRole } from '../users/schemas/user.schema';

const MINUTE = 60_000;

/**
 * A mid-call tool request: the arguments the language model chose, and the envelope
 * SnapServe put around them when it wrapped them (args, arguments, parameters or
 * input, possibly as a JSON string). Unwrapped, the whole body is the model's.
 */
function toolRequest(body: unknown): { args: Record<string, unknown>; envelope?: Record<string, any> } {
  const b = body && typeof body === 'object' ? (body as Record<string, any>) : {};
  for (const name of ['args', 'arguments', 'parameters', 'input']) {
    const v = b[name];
    if (v && typeof v === 'object') return { args: v, envelope: b };
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object') return { args: parsed, envelope: b };
      } catch {
        // Not JSON: fall through to the top level.
      }
    }
  }
  return { args: b };
}

/**
 * The call a tool request belongs to and the caller's number, read only from what the
 * provider sets: its headers, or the envelope around wrapped arguments. Never from the
 * arguments themselves, which the language model (and so the caller) controls: a
 * caller ID there would let anyone skip the date of birth. Absent, the DOB is required.
 */
function toolContext(envelope: Record<string, any> | undefined, headers: Record<string, unknown>): ToolContext {
  const e = envelope ?? {};
  const call = e.call ?? e.context ?? e.metadata ?? {};
  const pick = (...values: unknown[]) => {
    const v = values.find((x) => typeof x === 'string' || typeof x === 'number');
    return v === undefined ? undefined : String(v);
  };
  return {
    providerCallId: pick(headers['x-snapserve-call-id'], e.callId, e.call_id, call.id, call.callId),
    callerNumber: pick(headers['x-snapserve-from'], e.fromNumber, e.from_number, e.callerNumber, e.caller_number, call.fromNumber, call.from),
  };
}

/** Constant-time comparison of a presented secret with the configured one. */
const sameSecret = (presented: string, expected: string) => {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return !!expected && timingSafeEqual(digest(presented), digest(expected));
};

/**
 * Who may read the call log and transcripts, and place or withdraw calls: calls hold
 * patients' own words, which pharmacy and lab don't need.
 */
const CALL_LOG_ROLES = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];

@ApiTags('AI Call Agent')
@ApiBearerAuth()
@Controller('calls')
export class CallsController {
  constructor(
    private readonly calls: CallsService,
    private readonly inbound: InboundService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Roles(...CALL_LOG_ROLES)
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
    return {
      ...this.calls.providerInfo,
      settings: await this.calls.agentSettings(),
      // What is set up on the server (never the secrets themselves).
      setup: {
        webhookSecret: !!this.config.get<string>('callAgent.webhookSecret'),
        signingSecret: !!this.config.get<string>('callAgent.snapserve.signingSecret'),
        inboundTools: !!this.config.get<string>('callAgent.toolsSecret'),
        inboundAgent: !!this.config.get<string>('callAgent.snapserve.inboundAgentId'),
        testNumbers: (this.config.get<string[]>('callAgent.allowedNumbers') ?? []).length,
      },
    };
  }

  @Get('scripts')
  @ApiOperation({ summary: "The voice agents' scripts, outcomes, data fields and inbound tools (to set up the provider's agents)" })
  scripts() {
    return this.calls.scripts();
  }

  @Post('provider-check')
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOperation({ summary: "Check the voice provider's API key, agents and balance without placing a call" })
  checkProvider() {
    return this.calls.checkProvider();
  }

  @Get('slots')
  @ApiOperation({ summary: 'Free slots the booking agent would offer' })
  @ApiQuery({ name: 'from', required: false, description: 'YYYY-MM-DD (default now)' })
  slots(@Query() query: SlotsQueryDto) {
    return this.calls.freeSlots(query.from, query.count);
  }

  @Post('confirmation')
  @Roles(...CALL_LOG_ROLES)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOperation({ summary: 'Call a patient to confirm a scheduled appointment (queued until calling hours if outside them)' })
  confirm(@Body() dto: ConfirmationCallDto, @CurrentUser('name') user: string) {
    return this.calls.requestConfirmation(dto.appointmentId, user || 'Staff');
  }

  @Post('booking')
  @Roles(...CALL_LOG_ROLES)
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
   * the provider sends CALL_WEBHOOK_SECRET in the X-MediOS-Webhook-Token header, or
   * (when it can only be given a URL) as ?token=. Error logs redact the query string.
   */
  @Public()
  @Post('webhook/:provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Voice provider post-call webhook (authenticated by the X-MediOS-Webhook-Token header, or ?token=)' })
  async webhook(
    @Param('provider') provider: string,
    @Query('token') token: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-snapserve-signature') signature?: string,
    @Headers('x-snapserve-timestamp') timestamp?: string,
    @Headers('x-medios-webhook-token') headerToken?: string,
  ) {
    if (provider !== 'snapserve' || this.calls.providerInfo.provider !== 'snapserve') throw new NotFoundException();
    // The header wins when present; the URL token is the fallback.
    if (!sameSecret(String(headerToken ?? token ?? ''), this.config.get<string>('callAgent.webhookSecret') ?? '')) {
      throw new UnauthorizedException('Invalid webhook token');
    }
    const signingSecret = this.config.get<string>('callAgent.snapserve.signingSecret');
    if (signingSecret && !validSnapServeSignature(req.rawBody, signature, timestamp, signingSecret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    return this.calls.recordResult(parseSnapServeResult(body));
  }

  /**
   * The inbound agent's mid-call tools (find_patient, find_free_slots, book_appointment…).
   * Server-to-server: SnapServe sends CALL_TOOLS_SECRET as X-Webhook-Secret. The
   * answer goes to the voice agent's language model as plain JSON (not wrapped).
   * Off (404) unless calls are on: snapserve, or simulated in development.
   */
  @Public()
  @Post('tools/:tool')
  @Throttle({ default: { limit: 120, ttl: MINUTE } })
  @ApiOperation({ summary: 'Inbound agent mid-call tool (authenticated by X-Webhook-Secret)' })
  async tool(
    @Param('tool') tool: string,
    @Headers('x-webhook-secret') secret: string | undefined,
    @Headers() headers: Record<string, unknown>,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const expected = this.config.get<string>('callAgent.toolsSecret');
    if (!expected) throw new NotFoundException('Inbound tools are not enabled (CALL_TOOLS_SECRET is not set).');
    if (!['snapserve', 'simulated'].includes(this.calls.providerInfo.provider)) throw new NotFoundException('Inbound tools are off: the call agent is not configured (CALL_PROVIDER).');
    if (!sameSecret(String(secret ?? ''), expected)) throw new UnauthorizedException('Invalid tool secret');
    const { args, envelope } = toolRequest(body);
    res.status(HttpStatus.OK).json(await this.inbound.run(tool, args, toolContext(envelope, headers)));
  }

  @Get(':id')
  @Roles(...CALL_LOG_ROLES)
  @ApiOperation({ summary: "One call with its transcript (the provider's raw payload for admins only)" })
  findOne(@Param('id') id: string, @CurrentUser('role') role: string) {
    return this.calls.findOne(id, role === UserRole.ADMIN);
  }

  @Post(':id/cancel')
  @Roles(...CALL_LOG_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw a call that has not been placed yet' })
  cancel(@Param('id') id: string, @CurrentUser('name') user: string) {
    return this.calls.cancel(id, user || 'Staff');
  }
}
