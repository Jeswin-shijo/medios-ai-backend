import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { debounceTime } from 'rxjs';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ADMIT_ROLES, Actor, HOUSEKEEPING_ROLES, REQUEST_ROLES, actorOf } from './actor';
import { BedAgentService } from './bed-agent.service';
import { BedEvents } from './bed-events';
import { BedsService } from './beds.service';
import { assertSuggestionFitsBed } from './transfer-check';
import { SuggestionsService } from './suggestions.service';
import { AdmitBedDto, BlockBedDto, DischargeBedDto, HoldBedDto, SuggestBedsDto, TransferBedDto } from './dto/beds.dto';

/** A comment line goes out this often so proxies keep the stream open. */
const PING_MS = 25_000;
const OK = { ok: true };

@ApiTags('Beds')
@ApiBearerAuth()
@Controller('beds')
export class BedsController {
  constructor(
    private readonly beds: BedsService,
    private readonly suggestions: SuggestionsService,
    private readonly events: BedEvents,
    private readonly agent: BedAgentService,
  ) {}

  @Get('board')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Every ward and bed with its state, and the totals' })
  board(@CurrentUser() user: any) {
    return this.beds.board(actorOf(user));
  }

  /**
   * Tells an open bed board that something changed (it then re-reads the board).
   * `@Res()` takes the response over, so the JSON wrapper does not apply.
   */
  @Get('stream')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'Live bed changes (text/event-stream): "changed", "request" and "ping" events' })
  stream(@Req() req: Request, @Res() res: Response) {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
    });
    res.flushHeaders();

    let closed = false;
    const write = (event: string, data: unknown) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const changes = this.events.changes$.pipe(debounceTime(150)).subscribe(() => write('changed', {}));
    // Request changes go out as they happen, not debounced.
    const requests = this.events.requests$.subscribe((e) => write('request', e));
    const ping = setInterval(() => write('ping', {}), PING_MS);
    req.on('close', () => {
      closed = true;
      changes.unsubscribe();
      requests.unsubscribe();
      clearInterval(ping);
    });

    write('ping', {});
  }

  @Post('suggestions')
  @Roles(...REQUEST_ROLES)
  @ApiOperation({ summary: 'Rank the beds for a patient by the fixed rules' })
  suggest(@CurrentUser() user: any, @Body() dto: SuggestBedsDto) {
    return this.suggestions.suggest(actorOf(user), dto);
  }

  @Post('suggestions/:id/refine')
  @Roles(...REQUEST_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the AI to reorder and explain the top beds' })
  refine(@CurrentUser() user: any, @Param('id') id: string) {
    return this.suggestions.refine(actorOf(user), id);
  }

  @Get(':bedId/admission')
  @Roles(...ADMIT_ROLES)
  @ApiOperation({ summary: 'The admitted patient in a bed and their admission request, to start a transfer' })
  admission(@Param('bedId') bedId: string) {
    return this.beds.admissionInBed(bedId);
  }

  @Post(':bedId/hold')
  @Roles(...REQUEST_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hold a free bed for 5 minutes while the choice is confirmed' })
  async hold(@CurrentUser() user: any, @Param('bedId') bedId: string, @Body() dto: HoldBedDto) {
    // The suggestion's patient: a held twin bed keeps its room to that patient's gender.
    const gender = await this.suggestions.patientGender(dto.suggestionId);
    return this.beds.hold(bedId, actorOf(user), dto.suggestionId, gender);
  }

  @Delete(':bedId/hold')
  @Roles(...REQUEST_ROLES)
  @ApiOperation({ summary: 'Give back a hold' })
  async release(@CurrentUser() user: any, @Param('bedId') bedId: string) {
    await this.beds.release(bedId, actorOf(user));
    return { released: true };
  }

  @Post(':bedId/admit')
  @Roles(...REQUEST_ROLES)
  @ApiOperation({ summary: 'Admit the suggestion\'s patient to a held bed' })
  async admit(@CurrentUser() user: any, @Param('bedId') bedId: string, @Body() dto: AdmitBedDto) {
    const actor = actorOf(user);
    const log = await this.suggestions.authorizeChoice(dto.suggestionId, bedId, actor, dto);
    const admission = await this.beds.admit(bedId, actor, {
      patientId: String(log.patient),
      suggestionId: dto.suggestionId,
      doctor: log.request.doctor,
      department: log.request.department,
      roomClass: log.request.roomClass,
      needs: log.request.needs,
      notes: log.request.notes,
      expectedStayDays: log.request.expectedStayDays,
    });
    await this.suggestions.recordChoice(dto.suggestionId, { bedId, admissionId: String(admission._id), ...pick(dto) });
    await this.closeRequest(dto.requestId, bedId, admission, actor, dto);
    return admission;
  }

  @Post(':bedId/transfer')
  @Roles(...REQUEST_ROLES)
  @ApiOperation({ summary: 'Move an admitted patient to a held bed' })
  async transfer(@CurrentUser() user: any, @Param('bedId') bedId: string, @Body() dto: TransferBedDto) {
    const actor = actorOf(user);
    const log = await this.suggestions.authorizeChoice(dto.suggestionId, dto.toBedId, actor, dto);
    // Before anything changes: the suggestion must be for the patient in this bed.
    assertSuggestionFitsBed(log, bedId, await this.beds.activeAdmissionForPatient(String(log.patient)));
    const admission = await this.beds.transfer(bedId, actor, {
      toBedId: dto.toBedId,
      suggestionId: dto.suggestionId,
      reason: dto.reason,
    });
    await this.suggestions.recordChoice(dto.suggestionId, { bedId: dto.toBedId, admissionId: String(admission._id), ...pick(dto) });
    await this.closeRequest(dto.requestId, dto.toBedId, admission, actor, dto);
    return admission;
  }

  /** The staff choice answers its bed request, if the screen named one. */
  private async closeRequest(
    requestId: string | undefined,
    bedId: string,
    admission: { _id: unknown },
    actor: Actor,
    dto: { suggestionId: string; reason?: string; ruleOverride?: boolean },
  ) {
    if (!requestId) return;
    const { wards, beds } = await this.beds.inventory();
    const bed = beds.find((b) => b.id === bedId);
    const ward = wards.find((w) => w.id === bed?.wardId);
    await this.agent.completeByHand(requestId, {
      bedId,
      bedLabel: bed?.label ?? '',
      wardName: ward?.name ?? '',
      admissionId: String(admission._id),
      actor,
      reason: dto.reason,
      ruleOverride: dto.ruleOverride,
      suggestionId: dto.suggestionId,
    });
  }

  @Post(':bedId/discharge')
  @Roles(...ADMIT_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Discharge the admission named (none for a sample occupant); the bed goes to cleaning' })
  async discharge(@CurrentUser() user: any, @Param('bedId') bedId: string, @Body() dto: DischargeBedDto) {
    await this.beds.discharge(bedId, actorOf(user), dto.admissionId ?? null);
    return OK;
  }

  @Post(':bedId/clean')
  @Roles(...HOUSEKEEPING_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a bed cleaned and free' })
  async clean(@CurrentUser() user: any, @Param('bedId') bedId: string) {
    await this.beds.markCleaned(bedId, actorOf(user));
    return OK;
  }

  @Post(':bedId/block')
  @Roles(...HOUSEKEEPING_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a free bed out of use, with a reason' })
  async block(@CurrentUser() user: any, @Param('bedId') bedId: string, @Body() dto: BlockBedDto) {
    await this.beds.block(bedId, actorOf(user), dto.reason);
    return OK;
  }

  @Post(':bedId/unblock')
  @Roles(...HOUSEKEEPING_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Put a blocked bed back in use' })
  async unblock(@CurrentUser() user: any, @Param('bedId') bedId: string) {
    await this.beds.unblock(bedId, actorOf(user));
    return OK;
  }
}

/** The choice fields to log. */
const pick = (dto: { reason?: string; ruleOverride?: boolean }) => ({ reason: dto.reason, ruleOverride: dto.ruleOverride });
