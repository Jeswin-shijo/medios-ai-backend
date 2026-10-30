import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import {
  AdjustDto,
  AnswerDto,
  ApproveDto,
  CheckDto,
  FlagParam,
  IdParam,
  IssueDto,
  LevelDto,
  MovementsQueryDto,
  PharmacyOrderDto,
  OrdersQueryDto,
  QueryDto,
  PharmacyReasonDto,
  ReceiveDto,
  SinceQueryDto,
  PharmacySnapshotQueryDto,
  StoreQueryDto,
  WorklistQueryDto,
} from './dto/pharmacy.dto';
import { PharmacyAiService } from './pharmacy-ai';
import { DOSES_PER_DAY, MEDICINES, ROUTE_LABEL, STORE_LABEL, Frequency, Route, Store } from './pharmacy-catalogue';
import { PharmacyChecksService } from './pharmacy-checks.service';
import { PharmacyIssueService } from './pharmacy-issue.service';
import { PharmacyOrdersService } from './pharmacy-orders.service';
import { PharmacyOverviewService } from './pharmacy-overview.service';
import { PharmacyPrescriptionsService } from './pharmacy-prescriptions.service';
import { PharmacySettingsService } from './pharmacy-settings.service';
import { PharmacyStockService } from './pharmacy-stock.service';
import { QUERY_KINDS } from './schemas/pharmacy-line.schema';
import { ADJUST_REASONS } from './schemas/pharmacy-movement.schema';
import { PHARMACY_PRIORITIES } from './schemas/pharmacy-order.schema';

/** Every read, and Explain. */
const PHARMACY_READ = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.PHARMACIST];
/** Preview checks, order, cancel unissued lines and answer queries. A doctor or admin confirms an allergy, answers a query and cancels (Y4). */
const PHARMACY_ORDER = [UserRole.ADMIN, UserRole.DOCTOR];
/** Approve, query, reject, issue, out of stock. */
const PHARMACY_CHECK = [UserRole.ADMIN, UserRole.PHARMACIST];
/** Receive, adjust, remove expired, reorder levels. */
const PHARMACY_STOCK = [UserRole.ADMIN, UserRole.PHARMACIST];
const ADMIN = [UserRole.ADMIN];

/** A settings body must be a plain object: an array or null is a 400 before the service sees it. */
function plainObject(body: unknown): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('The body must be an object');
}

@ApiTags('Pharmacy')
@ApiBearerAuth()
@Controller('pharmacy')
export class PharmacyController {
  constructor(
    private readonly orders: PharmacyOrdersService,
    private readonly checks: PharmacyChecksService,
    private readonly issue: PharmacyIssueService,
    private readonly stock: PharmacyStockService,
    private readonly overview: PharmacyOverviewService,
    private readonly settings: PharmacySettingsService,
    private readonly ai: PharmacyAiService,
    private readonly prescriptions: PharmacyPrescriptionsService,
  ) {}

  // ---------- reference data and overview ----------

  @Get('catalogue')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'The medicines and products, routes, frequencies, priorities, stores, query kinds, adjust reasons and targets' })
  async catalogue() {
    const { targets, nearExpiryDays } = await this.settings.get();
    return {
      medicines: MEDICINES.map((m) => ({
        key: m.key,
        name: m.name,
        unit: m.unit,
        classKey: m.classKey,
        classLabel: m.classLabel,
        products: m.products.map((p) => ({ key: p.key, label: p.label, form: p.form, strength: p.strength, unit: p.unit, issueUnit: p.issueUnit, routes: p.routes })),
      })),
      routes: (Object.keys(ROUTE_LABEL) as Route[]).map((key) => ({ key, label: ROUTE_LABEL[key] })),
      frequencies: (Object.keys(DOSES_PER_DAY) as Frequency[]).map((key) => ({ key, dosesPerDay: DOSES_PER_DAY[key], hasDuration: key !== 'STAT' })),
      priorities: PHARMACY_PRIORITIES,
      stores: (Object.keys(STORE_LABEL) as Store[]).map((key) => ({ key, label: STORE_LABEL[key] })),
      queryKinds: QUERY_KINDS,
      adjustReasons: ADJUST_REASONS,
      targets,
      nearExpiryDays,
    };
  }

  @Get('overview')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'Pharmacy cards, check time, stock alerts and performance' })
  getOverview() {
    return this.overview.overview();
  }

  @Get('snapshots')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'Hourly pharmacy counts for the last 24 hours or 7 days' })
  snapshots(@Query() q: PharmacySnapshotQueryDto) {
    return this.overview.series(q.range ?? '24h');
  }

  // ---------- reading orders and lines ----------

  @Get('orders')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'Medicine orders, newest first' })
  async listOrders(@Query() q: OrdersQueryDto) {
    return { orders: await this.orders.list({ status: q.status as any, search: q.search, setting: q.setting, limit: q.limit }) };
  }

  @Get('orders/:id')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'One order with its lines' })
  getOrder(@Param() p: IdParam) {
    return this.orders.get(p.id);
  }

  @Get('prescriptions/:id/status')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'Where each item of a prescription is in Pharmacy' })
  prescriptionStatus(@Param() p: IdParam) {
    return this.prescriptions.status(p.id);
  }

  @Get('lines/:id')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'One medicine line' })
  getLine(@Param() p: IdParam) {
    return this.orders.line(p.id);
  }

  @Get('patients/:id/lines')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: "One patient's medicine lines, newest first" })
  async patientLines(@Param() p: IdParam, @Query() q: SinceQueryDto) {
    return { lines: await this.orders.linesForPatient(p.id, q.since) };
  }

  @Get('worklist')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: "The pharmacist's lists: lines to check, lines to issue, queries" })
  async worklist(@Query() q: WorklistQueryDto) {
    return { lines: await this.orders.worklist(q.view) };
  }

  // ---------- ordering ----------

  @Post('check')
  @Roles(...PHARMACY_ORDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check lines against the patient and their other medicines, without saving' })
  check(@Body() dto: CheckDto) {
    return this.orders.preview({ patientId: dto.patientId, lines: dto.lines });
  }

  @Post('orders')
  @Roles(...PHARMACY_ORDER)
  @ApiOperation({ summary: 'Order 1 to 10 medicine lines at one priority; a red allergy needs the doctor\'s reason on its line' })
  order(@CurrentUser() user: any, @Body() dto: PharmacyOrderDto) {
    return this.orders.order(actorOf(user), { patientId: dto.patientId, priority: dto.priority, note: dto.note, lines: dto.lines });
  }

  @Post('lines/:id/cancel')
  @Roles(...PHARMACY_ORDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a line that is not issued' })
  cancel(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: PharmacyReasonDto) {
    return this.checks.cancel(actorOf(user), p.id, dto.reason);
  }

  @Post('lines/:id/answer')
  @Roles(...PHARMACY_ORDER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Answer the open query on a line: keep, change, switch, wait, cancel or stop' })
  answer(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: AnswerDto) {
    return this.checks.answer(actorOf(user), p.id, dto);
  }

  // ---------- the pharmacist ----------

  @Post('lines/:id/approve')
  @Roles(...PHARMACY_CHECK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a line (a reason for a red flag; Allergy reviewed for an amber allergy)' })
  approve(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: ApproveDto) {
    return this.checks.approve(actorOf(user), p.id, dto);
  }

  @Post('lines/:id/query')
  @Roles(...PHARMACY_CHECK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the doctor about a line' })
  query(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: QueryDto) {
    return this.checks.query(actorOf(user), p.id, { kind: dto.kind as any, question: dto.question });
  }

  @Post('lines/:id/reject')
  @Roles(...PHARMACY_CHECK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a line with a reason' })
  reject(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: PharmacyReasonDto) {
    return this.checks.reject(actorOf(user), p.id, dto.reason);
  }

  @Get('lines/:id/issue-options')
  @Roles(...PHARMACY_CHECK)
  @ApiOperation({ summary: "What the issue form offers: the line's quantity, the default store and each store's usable batches" })
  issueOptions(@Param() p: IdParam) {
    return this.issue.issueOptions(p.id);
  }

  @Post('lines/:id/issue')
  @Roles(...PHARMACY_CHECK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Issue an approved line from stock, oldest expiry first' })
  doIssue(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: IssueDto) {
    return this.issue.issue(actorOf(user), p.id, dto);
  }

  @Post('lines/:id/out-of-stock')
  @Roles(...PHARMACY_CHECK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Nothing in stock: ask the doctor to switch, wait or cancel' })
  outOfStock(@CurrentUser() user: any, @Param() p: IdParam) {
    return this.issue.outOfStock(actorOf(user), p.id);
  }

  @Post('lines/:id/flags/:key/explain')
  @Roles(...PHARMACY_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Explain one flag in a sentence (the AI sees no names, ids or free text)' })
  explain(@Param() p: FlagParam) {
    return this.ai.explain(p.id, p.key);
  }

  // ---------- stock ----------

  @Get('stock')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'Stock by product and store, with batches' })
  async getStock(@Query() q: StoreQueryDto) {
    return { stock: await this.stock.stock(q.store) };
  }

  @Get('stock/movements')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'Stock movements, newest first' })
  async movements(@Query() q: MovementsQueryDto) {
    return { movements: await this.stock.movements(q) };
  }

  @Post('stock/receive')
  @Roles(...PHARMACY_STOCK)
  @ApiOperation({ summary: 'Receive a batch into a store' })
  receive(@CurrentUser() user: any, @Body() dto: ReceiveDto) {
    return this.stock.receive(actorOf(user), dto);
  }

  @Post('stock/batches/:id/adjust')
  @Roles(...PHARMACY_STOCK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Adjust a batch (damaged, expired or a count correction)' })
  adjust(@CurrentUser() user: any, @Param() p: IdParam, @Body() dto: AdjustDto) {
    return this.stock.adjust(actorOf(user), p.id, { change: dto.change, reason: dto.reason as any });
  }

  @Post('stock/batches/:id/remove-expired')
  @Roles(...PHARMACY_STOCK)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove what is left of an expired batch' })
  removeExpired(@CurrentUser() user: any, @Param() p: IdParam) {
    return this.stock.removeExpired(actorOf(user), p.id);
  }

  @Put('stock/levels')
  @Roles(...PHARMACY_STOCK)
  @ApiOperation({ summary: 'Set the reorder level of a product in a store' })
  setLevel(@CurrentUser() user: any, @Body() dto: LevelDto) {
    return this.stock.setLevel(actorOf(user), dto);
  }

  // ---------- settings ----------

  @Get('settings')
  @Roles(...PHARMACY_READ)
  @ApiOperation({ summary: 'Targets in minutes and the near-expiry window' })
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...ADMIN)
  @ApiOperation({ summary: 'Change targets and the near-expiry window (admin)' })
  saveSettings(@CurrentUser() user: any, @Body() body: Record<string, unknown>) {
    plainObject(body);
    return this.settings.save(actorOf(user), body);
  }
}
