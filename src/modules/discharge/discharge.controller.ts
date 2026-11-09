import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../beds/actor';
import { DischargeLeavingService, GatePassView } from './discharge-leaving.service';
import { DischargeLinesService } from './discharge-lines.service';
import { DischargeOrdersService, OrderInput, OrderPatch } from './discharge-orders.service';
import { DischargeDetail, DischargeOverviewService, QueueStatusFilter, SummaryView, summaryView } from './discharge-overview.service';
import { DischargePlansService } from './discharge-plans.service';
import { DIS_ADMIN, DIS_LEAVE, DIS_ORDER, DIS_READ, DIS_TICK, DIS_WARD } from './discharge-roles';
import { DischargeSettingsService } from './discharge-settings.service';
import { DischargeSummaryService } from './discharge-summary.service';
import {
  AdmissionIdParam,
  DischargeCheckDto,
  DischargeLabRequestParam,
  DischargeLineParam,
  DischargeOrderIdParam,
  DischargeQueueQueryDto,
  DischargeReasonDto,
  DischargeSignDto,
  DischargeSummarySaveDto,
  DischargeTargetDto,
  DischargeTickDto,
  EditDischargeOrderDto,
  LeftWithoutDischargeDto,
  OrderDischargeDto,
  PatientIdParam,
  PlanIdParam,
} from './dto/discharge.dto';
import type { DischargeSummaryDocument } from './schemas/discharge-summary.schema';

/** A summary as the editor reads it (the record's own `updatedAt` included, for `seen`). */
const view = (s: DischargeSummaryDocument): SummaryView => summaryView(s.toObject());

/**
 * Discharge routes (`/api/discharge`). Each maps to a service method, which checks the role again and decides; a
 * service's 400, 403, 404 or 409 passes through unchanged. A change to a plan or an order answers with that plan's
 * checklist panel (`DischargeDetail`), so the page shows what the server now holds; the summary routes answer with the
 * summary view, the gate pass with what it prints. Pharmacist and lab are in no role list: every route is 403 for them.
 */
@ApiTags('Discharge')
@ApiBearerAuth()
@Controller('discharge')
export class DischargeController {
  constructor(
    private readonly overview: DischargeOverviewService,
    private readonly plans: DischargePlansService,
    private readonly orders: DischargeOrdersService,
    private readonly lines: DischargeLinesService,
    private readonly summary: DischargeSummaryService,
    private readonly leaving: DischargeLeavingService,
    private readonly settings: DischargeSettingsService,
  ) {}

  // ---------- the page ----------

  @Get('overview')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'The five cards and "Today and tomorrow"' })
  getOverview() {
    return this.overview.overview();
  }

  @Get('queue')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'Every discharge plan in progress, filtered by ward, doctor, status or search' })
  queue(@Query() q: DischargeQueueQueryDto) {
    return this.overview.queue({ ward: q.ward, doctor: q.doctor, status: q.status as QueueStatusFilter | undefined, q: q.q });
  }

  @Get('plans/:planId')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'The checklist panel of a plan' })
  detail(@Param() p: PlanIdParam) {
    return this.overview.detail(p.planId);
  }

  @Get('admissions/:admissionId')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'The checklist panel, found by the admission (404 when it has no plan, such as a sample one)' })
  byAdmission(@Param() p: AdmissionIdParam) {
    return this.overview.byAdmission(p.admissionId);
  }

  @Get('patients/:patientId/line')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'A patient\'s one-line discharge status (null with no plan in progress)' })
  patientLine(@Param() p: PatientIdParam) {
    return this.overview.patientLine(p.patientId);
  }

  @Get('summaries/to-sign')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'Unsigned summaries of orders in progress, oldest draft first' })
  toSign() {
    return this.summary.toSign();
  }

  @Get('left-today')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'The stays that ended today, newest first' })
  leftToday() {
    return this.overview.leftToday();
  }

  @Post('day-summary')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'Summarise today (the AI sees counts only)' })
  daySummary() {
    return this.overview.daySummary();
  }

  // ---------- plans ----------

  @Patch('plans/:planId/target')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Move the target date (doctor or admin)' })
  async setTarget(@CurrentUser() user: unknown, @Param() p: PlanIdParam, @Body() dto: DischargeTargetDto): Promise<DischargeDetail> {
    await this.plans.setTarget(actorOf(user), p.planId, dto.targetDay, dto.note);
    return this.overview.detail(p.planId);
  }

  @Post('plans/:planId/order')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Order the discharge (doctor or admin): places the take-home medicines and books the follow-up' })
  async order(@CurrentUser() user: unknown, @Param() p: PlanIdParam, @Body() dto: OrderDischargeDto): Promise<DischargeDetail> {
    return this.detailOf(await this.orders.order(actorOf(user), p.planId, dto as OrderInput));
  }

  @Post('plans/:planId/left-without-discharge')
  @Roles(...DIS_WARD)
  @ApiOperation({ summary: 'Record a patient who left without discharge (nurse or admin)' })
  async leftWithoutDischarge(@CurrentUser() user: unknown, @Param() p: PlanIdParam, @Body() dto: LeftWithoutDischargeDto): Promise<DischargeDetail> {
    await this.leaving.leftWithoutDischarge(actorOf(user), p.planId, dto);
    return this.overview.detail(p.planId);
  }

  // ---------- orders ----------

  @Post('orders/check')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'The live safety flags of take-home medicines for the plan\'s patient (nothing is saved)' })
  check(@CurrentUser() user: unknown, @Body() dto: DischargeCheckDto) {
    return this.orders.preview(actorOf(user), { planId: dto.planId, lines: dto.lines });
  }

  @Patch('orders/:id')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Change the order while the patient is still in the bed' })
  async edit(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam, @Body() dto: EditDischargeOrderDto): Promise<DischargeDetail> {
    return this.detailOf(await this.orders.edit(actorOf(user), p.id, dto as OrderPatch));
  }

  @Post('orders/:id/cancel')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Cancel the order with a reason' })
  async cancel(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam, @Body() dto: DischargeReasonDto): Promise<DischargeDetail> {
    return this.detailOf(await this.orders.cancel(actorOf(user), p.id, dto.reason));
  }

  @Post('orders/:id/start-now')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Open the discharge window now' })
  async startNow(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam): Promise<DischargeDetail> {
    return this.detailOf(await this.orders.startNow(actorOf(user), p.id));
  }

  @Post('orders/:id/lines/:key')
  @Roles(...DIS_TICK)
  @ApiOperation({ summary: 'Tick a line: a doctor\'s line or "not needed" needs a doctor or admin, a nurse\'s line a nurse or admin' })
  async tick(@CurrentUser() user: unknown, @Param() p: DischargeLineParam, @Body() dto: DischargeTickDto): Promise<DischargeDetail> {
    return this.detailOf(await this.lines.tick(actorOf(user), p.id, p.key, dto));
  }

  @Post('orders/:id/lab/:requestId/follow-up-later')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Put a Lab request off as "follow up later" (never one with a critical result to acknowledge)' })
  async followUpLater(@CurrentUser() user: unknown, @Param() p: DischargeLabRequestParam): Promise<DischargeDetail> {
    return this.detailOf(await this.lines.followUpLater(actorOf(user), p.id, p.requestId));
  }

  @Post('orders/:id/bill-override')
  @Roles(...DIS_ADMIN)
  @ApiOperation({ summary: 'Mark the bill line done when the stay has no bill at all (admin, with a reason)' })
  async overrideBill(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam, @Body() dto: DischargeReasonDto): Promise<DischargeDetail> {
    return this.detailOf(await this.lines.overrideBill(actorOf(user), p.id, dto.reason));
  }

  // ---------- the summary ----------

  @Get('orders/:id/summary')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'The summary, drafted first if there is none (unedited sections follow the record until signed)' })
  async getSummary(@Param() p: DischargeOrderIdParam): Promise<SummaryView> {
    return view(await this.summary.draft(p.id));
  }

  @Put('orders/:id/summary')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Save edits to the version the editor loaded (409 SUMMARY_CHANGED otherwise)' })
  async saveSummary(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam, @Body() dto: DischargeSummarySaveDto): Promise<SummaryView> {
    return view(await this.summary.save(actorOf(user), p.id, dto.sections ?? {}, dto.course, dto.seen));
  }

  @Post('orders/:id/summary/sign')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Sign the version the editor loaded (409 SUMMARY_CHANGED otherwise)' })
  async signSummary(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam, @Body() dto: DischargeSignDto): Promise<SummaryView> {
    return view(await this.summary.sign(actorOf(user), p.id, dto.seen));
  }

  @Post('orders/:id/summary/unlock')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Edit and re-sign: unlock a signed summary (its document is archived)' })
  async unlockSummary(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam): Promise<SummaryView> {
    return view(await this.summary.unlock(actorOf(user), p.id));
  }

  @Post('orders/:id/summary/redraft-course')
  @Roles(...DIS_ORDER)
  @ApiOperation({ summary: 'Write the course paragraph again (only unsigned and not written by hand)' })
  async redraftCourse(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam): Promise<SummaryView> {
    return view(await this.summary.redraftCourse(actorOf(user), p.id));
  }

  // ---------- leaving ----------

  @Post('orders/:id/gate-pass')
  @Roles(...DIS_LEAVE)
  @ApiOperation({ summary: 'Print the gate pass once Ready; a later print, and one after leaving, is a reprint' })
  gatePass(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam): Promise<GatePassView> {
    return this.leaving.gatePass(actorOf(user), p.id);
  }

  @Post('orders/:id/left')
  @Roles(...DIS_LEAVE)
  @ApiOperation({ summary: 'Patient left, after the gate pass (Home, Transfer, Against advice)' })
  async left(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam): Promise<DischargeDetail> {
    return this.detailOf(await this.leaving.left(actorOf(user), p.id));
  }

  @Post('orders/:id/body-released')
  @Roles(...DIS_LEAVE)
  @ApiOperation({ summary: 'Body released (Died)' })
  async bodyReleased(@CurrentUser() user: unknown, @Param() p: DischargeOrderIdParam): Promise<DischargeDetail> {
    return this.detailOf(await this.leaving.bodyReleased(actorOf(user), p.id));
  }

  // ---------- settings ----------

  @Get('settings')
  @Roles(...DIS_READ)
  @ApiOperation({ summary: 'Settings → Discharge' })
  getSettings() {
    return this.settings.get();
  }

  /** The body is not a whitelisting DTO: the service must see an unknown key to refuse it (400). */
  @Put('settings')
  @Roles(...DIS_ADMIN)
  @ApiOperation({ summary: 'Change Settings → Discharge (admin)' })
  saveSettings(@CurrentUser() user: unknown, @Body() body: Record<string, unknown>) {
    return this.settings.save(actorOf(user), body);
  }

  // ---------- helpers ----------

  /** The checklist panel of the order's plan, as it stands after the change. */
  private detailOf(order: { plan: unknown }): Promise<DischargeDetail> {
    return this.overview.detail(String(order.plan));
  }
}
