import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseArrayPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import {
  ArrivalDto,
  BayAssignDto,
  BayDto,
  BayQueryDto,
  CancelPathwayDto,
  DispositionDto,
  ExpectedDto,
  HandoverDto,
  IdParam,
  PathwayParam,
  RetriageDto,
  SnapshotQueryDto,
  StepParam,
  TriageDto,
  TriageSuggestDto,
} from './dto/er.dto';
import { ErAiService } from './er-ai';
import { ErBaysService } from './er-bays.service';
import { COMPLAINTS, PATHWAYS, PathwayKey, StepKey } from './er-rules';
import { ErOverviewService } from './er-overview.service';
import { ErTargetsService } from './er-targets.service';
import { ErTriageService } from './er-triage.service';
import { ErVisitsService } from './er-visits.service';

/** See the board and take in arrivals. */
const FRONT = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];
/** Triage, pathways, steps, bays and the handover. */
const CLINICAL = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE];
/** Seen by a doctor and the decision about the patient. */
const DOCTORS = [UserRole.ADMIN, UserRole.DOCTOR];
const ADMIN = [UserRole.ADMIN];

@ApiTags('ER')
@ApiBearerAuth()
@Controller('er')
export class ErController {
  constructor(
    private readonly visits: ErVisitsService,
    private readonly triage: ErTriageService,
    private readonly bays: ErBaysService,
    private readonly targets: ErTargetsService,
    private readonly overview: ErOverviewService,
    private readonly ai: ErAiService,
  ) {}

  @Get('board')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'Open ER visits, most urgent first, and the expected arrivals' })
  board() {
    return this.visits.board();
  }

  @Get('complaints')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'The complaint list and the fast-track pathways, for the forms' })
  complaints() {
    return {
      complaints: COMPLAINTS,
      pathways: (Object.keys(PATHWAYS) as PathwayKey[]).map((key) => ({
        key,
        label: PATHWAYS[key].label,
        steps: PATHWAYS[key].steps.map((s) => ({ key: s.key, label: s.label })),
      })),
    };
  }

  @Get('overview')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'ER cards, colour table and performance' })
  getOverview() {
    return this.overview.overview();
  }

  @Get('snapshots')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'Hourly ER counts for the last 24 hours or 7 days' })
  snapshots(@Query() q: SnapshotQueryDto) {
    return this.overview.series(q.range ?? '24h');
  }

  @Get('bays')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'ER bays and stretchers, and who is in each' })
  async listBays() {
    return { bays: await this.bays.list() };
  }

  @Get('bays/suggest')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'The free bay to offer for a triage colour' })
  async suggestBay(@Query() q: BayQueryDto) {
    return { bay: await this.bays.suggest(q.colour) };
  }

  @Put('bays')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Replace the list of bays (admin)' })
  async saveBays(@CurrentUser() user: any, @Body(new ParseArrayPipe({ items: BayDto })) body: BayDto[]) {
    return { bays: await this.bays.save(actorOf(user), body) };
  }

  @Get('targets')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'Pathway step targets, in minutes from arrival' })
  async getTargets() {
    return { targets: await this.targets.getTargets() };
  }

  @Put('targets')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Change pathway step targets (admin); send an object of "<pathway>.<step>": minutes' })
  async saveTargets(@CurrentUser() user: any, @Body() body: Record<string, unknown>) {
    return { targets: await this.targets.saveTargets(actorOf(user), body) };
  }

  @Post('triage/suggest')
  @Roles(...CLINICAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The rules suggest a colour and the AI explains it; nothing is saved' })
  async suggest(@Body() dto: TriageSuggestDto) {
    const vitals = dto.vitals ?? {};
    // The rules work out the colour and reasons here; nothing the client says about them is trusted.
    const suggestion = this.triage.suggest({ complaint: dto.complaint, vitals, painScore: dto.painScore });
    const explanation = await this.ai.explainTriage({ colour: suggestion.colour, reasons: suggestion.reasons, complaint: dto.complaint, vitals });
    return { ...suggestion, explanation: explanation.text, sample: explanation.sample };
  }

  @Post('arrivals')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'A patient arrives: by patient, UHID, card, or as an unknown emergency' })
  arrive(@CurrentUser() user: any, @Body() dto: ArrivalDto) {
    return this.visits.arrive(actorOf(user), dto);
  }

  @Post('expected')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'Add a patient who is on the way' })
  addExpected(@CurrentUser() user: any, @Body() dto: ExpectedDto) {
    return this.visits.addExpected(actorOf(user), dto);
  }

  @Delete('expected/:id')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'Remove an expected arrival that is still waiting' })
  async deleteExpected(@Param() p: IdParam) {
    await this.visits.deleteExpected(p.id);
    return { ok: true };
  }

  @Get('visits/:id')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'One ER visit' })
  getVisit(@Param() p: IdParam) {
    return this.visits.get(p.id);
  }

  @Post('visits/:id/triage')
  @Roles(...CLINICAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm triage: the colour, with a reason if it is lower than suggested' })
  doTriage(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: TriageDto) {
    return this.triage.triage(actorOf(user), p.id, { complaint: dto.complaint, vitals: dto.vitals ?? {}, painScore: dto.painScore, colour: dto.colour, reason: dto.reason });
  }

  @Post('visits/:id/retriage')
  @Roles(...CLINICAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the triage colour, with a reason' })
  retriage(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: RetriageDto) {
    return this.triage.retriage(actorOf(user), p.id, dto.colour, dto.reason);
  }

  @Post('visits/:id/pathways/:key')
  @Roles(...CLINICAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a fast-track pathway' })
  startPathway(@CurrentUser() user: any, @Param() p: PathwayParam) {
    return this.triage.startPathway(actorOf(user), p.id, p.key as PathwayKey);
  }

  @Post('visits/:id/pathways/:key/cancel')
  @Roles(...CLINICAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a running pathway, with a reason' })
  cancelPathway(@CurrentUser() user: any, @Param() p: PathwayParam, @Body() dto: CancelPathwayDto) {
    return this.triage.cancelPathway(actorOf(user), p.id, p.key as PathwayKey, dto.reason);
  }

  @Post('visits/:id/steps/:step')
  @Roles(...CLINICAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tick a pathway step as done' })
  tickStep(@CurrentUser() user: any, @Param() p: StepParam) {
    return this.triage.tickStep(actorOf(user), p.id, p.step as StepKey);
  }

  @Post('visits/:id/doctor-seen')
  @Roles(...DOCTORS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark the patient as seen by a doctor' })
  doctorSeen(@CurrentUser() user: any, @Param() p: IdParam) {
    return this.triage.doctorSeen(actorOf(user), p.id);
  }

  @Post('visits/:id/bay')
  @Roles(...CLINICAL)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Put the patient in a bay, or take them out with bayId null' })
  assignBay(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: BayAssignDto) {
    return this.bays.assign(actorOf(user), p.id, dto.bayId);
  }

  @Post('visits/:id/disposition')
  @Roles(...DOCTORS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "The doctor's decision: admit, home, transfer, left against advice or died" })
  disposition(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: DispositionDto) {
    return this.visits.dispose(actorOf(user), p.id, dto.kind, dto.notes);
  }

  @Get('visits/:id/handover-draft')
  @Roles(...FRONT)
  @ApiOperation({ summary: 'A drafted handover note for the nurse to edit' })
  async handoverDraft(@Param() p: IdParam) {
    const draft = await this.ai.draftHandover(p.id);
    return { text: draft.text, sample: draft.sample };
  }

  @Put('visits/:id/handover')
  @Roles(...CLINICAL)
  @ApiOperation({ summary: 'Save the handover note' })
  saveHandover(@Param() p: IdParam, @Body() dto: HandoverDto) {
    return this.visits.saveHandover(p.id, dto.note);
  }
}
