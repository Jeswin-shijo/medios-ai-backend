import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import { AckDto, AmendDto, AreaQueryDto, CollectDto, IdParam, OrderDto, ReasonDto, RejectDto, RequestsQueryDto, ResultsDto, SnapshotQueryDto } from './dto/lab.dto';
import { LabBenchService, REJECT_REASONS } from './lab-bench.service';
import { COLLECT_MINUTES, LAB_TESTS, TUBE_LABEL, TUBE_ORDER, rangeText } from './lab-catalogue';
import { LabOrdersService } from './lab-orders.service';
import { LabOverviewService } from './lab-overview.service';
import { LabResultsService } from './lab-results.service';
import { LabSettingsService } from './lab-settings.service';

/** Reads. */
const LAB_READ = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.LAB, UserRole.PHARMACIST];
/** Order tests and cancel them. */
const LAB_ORDER = [UserRole.ADMIN, UserRole.DOCTOR];
/** Collect samples, mark not collected, labels. */
const LAB_COLLECT = [UserRole.ADMIN, UserRole.NURSE, UserRole.LAB];
/** Receive, reject, enter, send back, release, amend. */
const LAB_BENCH = [UserRole.ADMIN, UserRole.LAB];
/** Acknowledge critical results. */
const LAB_ACK = [UserRole.ADMIN, UserRole.DOCTOR];
const ADMIN = [UserRole.ADMIN];

@ApiTags('Lab')
@ApiBearerAuth()
@Controller('lab')
export class LabController {
  constructor(
    private readonly orders: LabOrdersService,
    private readonly bench: LabBenchService,
    private readonly results: LabResultsService,
    private readonly settings: LabSettingsService,
    private readonly overview: LabOverviewService,
  ) {}

  // ---------- reference data ----------

  @Get('catalogue')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'The tests with their tube, parameters and targets, the priorities, tubes and rejection reasons' })
  async catalogue() {
    const targets = await this.settings.getTargets();
    return {
      tests: LAB_TESTS.map((t) => ({
        key: t.key,
        label: t.label,
        tube: t.tube,
        tubeLabel: TUBE_LABEL[t.tube],
        category: t.category,
        parameters: t.params.map((p) => ({ name: p.name, unit: p.unit, low: p.low ?? null, high: p.high ?? null, text: !!p.text, range: rangeText(t.key, p) })),
        targets: targets[t.key],
      })),
      priorities: (Object.keys(COLLECT_MINUTES) as (keyof typeof COLLECT_MINUTES)[]).map((key) => ({ key, collectWithinMinutes: COLLECT_MINUTES[key] })),
      tubes: TUBE_ORDER.map((key) => ({ key, label: TUBE_LABEL[key] })),
      rejectionReasons: REJECT_REASONS,
    };
  }

  @Get('overview')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'Lab cards, turnaround by test, performance and critical results' })
  getOverview() {
    return this.overview.overview();
  }

  @Get('snapshots')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'Hourly lab counts for the last 24 hours or 7 days' })
  snapshots(@Query() q: SnapshotQueryDto) {
    return this.overview.series(q.range ?? '24h');
  }

  // ---------- orders ----------

  @Get('requests')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'Lab requests, newest first' })
  async listRequests(@Query() q: RequestsQueryDto) {
    return { requests: await this.orders.list({ open: q.status === 'open' ? true : q.status === 'done' ? false : undefined, search: q.search, area: q.area }) };
  }

  @Get('requests/:id')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'One lab request with its tests and samples' })
  getRequest(@Param() p: IdParam) {
    return this.orders.get(p.id);
  }

  @Get('requests/:id/labels')
  @Roles(...LAB_COLLECT)
  @ApiOperation({ summary: 'Tube labels: sample number, tube, tests, UHID, request number, priority and order time (no name)' })
  async labels(@Param() p: IdParam) {
    return { labels: await this.orders.labels(p.id) };
  }

  @Get('patients/:id/requests')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: "One patient's lab requests" })
  async patientRequests(@Param() p: IdParam) {
    return { requests: await this.orders.forPatient(p.id) };
  }

  @Post('requests')
  @Roles(...LAB_ORDER)
  @ApiOperation({ summary: 'Order tests at one priority; with repeatAfterHours a repeat request is made as well' })
  async order(@CurrentUser() user: any, @Body() dto: OrderDto) {
    return { requests: await this.orders.order(actorOf(user), dto) };
  }

  @Post('lines/:id/cancel')
  @Roles(...LAB_ORDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel one test (a doctor cancels their own; an admin any)' })
  cancel(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: ReasonDto) {
    return this.orders.cancelLine(actorOf(user), p.id, dto.reason);
  }

  @Post('requests/:id/not-collected')
  @Roles(...LAB_COLLECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a request whose samples could not be collected' })
  notCollected(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: ReasonDto) {
    return this.orders.notCollected(actorOf(user), p.id, dto.reason);
  }

  // ---------- collection and the bench ----------

  @Get('collection')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'Samples waiting to be collected' })
  async collection(@Query() q: AreaQueryDto) {
    return { samples: await this.bench.collectionList(q.area) };
  }

  @Post('samples/collect')
  @Roles(...LAB_COLLECT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a sample collected, by its sample number' })
  async collect(@CurrentUser() user: any, @Body() dto: CollectDto) {
    await this.bench.collect(actorOf(user), dto.sampleNumber);
    return { ok: true };
  }

  @Post('samples/:id/receive')
  @Roles(...LAB_BENCH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The lab receives a collected sample' })
  async receive(@CurrentUser() user: any, @Param() p: IdParam) {
    await this.bench.receive(actorOf(user), p.id);
    return { ok: true };
  }

  @Post('samples/:id/reject')
  @Roles(...LAB_BENCH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a sample; a replacement is made to recollect' })
  async reject(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: RejectDto) {
    await this.bench.reject(actorOf(user), p.id, dto.reason, dto.note);
    return { ok: true };
  }

  @Get('worklist')
  @Roles(...LAB_BENCH)
  @ApiOperation({ summary: 'The bench: samples to receive, tests to enter, results to validate and ones sent back' })
  worklist() {
    return this.bench.worklist();
  }

  // ---------- results ----------

  @Put('lines/:id/results')
  @Roles(...LAB_BENCH)
  @ApiOperation({ summary: 'Enter results for a received test (parameter name -> value)' })
  async enter(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: ResultsDto) {
    await this.results.enterResults(actorOf(user), p.id, dto.values);
    return { ok: true };
  }

  @Post('lines/:id/send-back')
  @Roles(...LAB_BENCH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send entered results back to the bench with a reason' })
  async sendBack(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: ReasonDto) {
    await this.results.sendBack(actorOf(user), p.id, dto.reason);
    return { ok: true };
  }

  @Post('lines/:id/release')
  @Roles(...LAB_BENCH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate and release results; someone other than the person who entered them' })
  async release(@CurrentUser() user: any, @Param() p: IdParam) {
    await this.results.release(actorOf(user), p.id);
    return { ok: true };
  }

  @Post('lines/:id/amend')
  @Roles(...LAB_BENCH)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Amend a released result: new values and a reason; a second person validates' })
  async amend(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: AmendDto) {
    await this.results.amend(actorOf(user), p.id, dto.values, dto.reason);
    return { ok: true };
  }

  @Get('critical')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: "Today's critical results and whether each has been acknowledged" })
  async critical() {
    return { critical: (await this.overview.overview()).critical };
  }

  @Post('lines/:id/acknowledge')
  @Roles(...LAB_ACK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge a critical result' })
  async acknowledge(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: AckDto) {
    await this.results.acknowledge(actorOf(user), p.id, dto.note);
    return { ok: true };
  }

  // ---------- settings ----------

  @Get('targets')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'Turnaround targets in minutes, per test' })
  async getTargets() {
    return { targets: await this.settings.getTargets() };
  }

  @Put('targets')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Change turnaround targets (admin); send an object of "<test>": { stat, routine }' })
  async saveTargets(@CurrentUser() user: any, @Body() body: Record<string, unknown>) {
    return { targets: await this.settings.saveTargets(actorOf(user), body) };
  }

  @Get('limits')
  @Roles(...LAB_READ)
  @ApiOperation({ summary: 'Critical limits in force, and who changed them' })
  getLimits() {
    return this.settings.getLimits();
  }

  @Put('limits')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Change critical limits (admin); send an object of "<test>.<parameter>": { low, high }' })
  saveLimits(@CurrentUser() user: any, @Body() body: Record<string, unknown>) {
    return this.settings.saveLimits(actorOf(user), body);
  }
}
