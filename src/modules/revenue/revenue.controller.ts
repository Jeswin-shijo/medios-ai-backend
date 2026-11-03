import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { actorOf } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import {
  BillIdParam, BillsQueryDto, CorrectionDto, EstimateEditDto, RevenueIdParam, MissedChargeDto, RevenueOverviewQueryDto, PaymentDto, PaymentsQueryDto, PriceItemDto, PriceListQueryDto,
  CancelPaymentDto, RefundPayDto, RevenueSnapshotQueryDto,
} from './dto/revenue.dto';
import { PriceListService } from './price-list.service';
import { RevenueBillsService } from './revenue-bills.service';
import { CorrectionsService } from './revenue-corrections.service';
import { RevenueEstimatesService } from './revenue-estimates.service';
import { FinalBillService } from './revenue-final.service';
import { RevenueOverviewService } from './revenue-overview.service';
import { PaymentsService } from './revenue-payments.service';
import { RefundsService } from './revenue-refunds.service';
import { RevenueSettingsService } from './revenue-settings.service';
import type { BillKind, BillState } from './schemas/bill.schema';
import type { PriceCategory } from './revenue-catalogue';
import type { CorrectionKind } from './schemas/correction.schema';
import type { PaymentKind } from './schemas/payment.schema';

/** The running total only: a doctor or nurse sees one line, never a bill. */
const REV_TOTALS = [UserRole.ADMIN, UserRole.STAFF, UserRole.DOCTOR, UserRole.NURSE];
/** The Revenue page and every read; estimates, payments, charges, corrections, refunds, final bills, printing. */
const REV_DESK = [UserRole.ADMIN, UserRole.STAFF];
/** Price list edits, Settings → Revenue, cancelling payments. (Approvals go through the Coordinator, not a route.) */
const REV_ADMIN = [UserRole.ADMIN];

/**
 * Revenue routes. Each maps to a service method; a service's 409 passes through unchanged. No route applies a correction or
 * decides a correction or refund: an admin decides through the Coordinator's approvals (P10-b).
 */
@ApiTags('Revenue')
@ApiBearerAuth()
@Controller('revenue')
export class RevenueController {
  constructor(
    private readonly overview: RevenueOverviewService,
    private readonly billsService: RevenueBillsService,
    private readonly estimates: RevenueEstimatesService,
    private readonly paymentsService: PaymentsService,
    private readonly final: FinalBillService,
    private readonly corrections: CorrectionsService,
    private readonly refunds: RefundsService,
    private readonly prices: PriceListService,
    private readonly settings: RevenueSettingsService,
  ) {}

  // ---------- overview ----------

  @Get('overview')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Revenue cards, needs-action list, collections by mode and recent payments' })
  getOverview(@Query() q: RevenueOverviewQueryDto) {
    return this.overview.overview(q.day);
  }

  @Get('snapshots')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Hourly revenue counts for the last 24 hours or 7 days' })
  snapshots(@Query() q: RevenueSnapshotQueryDto) {
    return this.overview.series((q.range as '24h' | '7d') ?? '24h');
  }

  @Post('explain/:billId')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Explain a bill in plain words (the AI sees totals and counts only)' })
  explain(@Param() p: BillIdParam) {
    return this.overview.explain(p.billId);
  }

  @Post('summary')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Summarise today (the AI sees totals and counts only)' })
  summary() {
    return this.overview.summarise();
  }

  // ---------- bills ----------

  @Get('bills')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Bills, newest first' })
  bills(@Query() q: BillsQueryDto) {
    return this.billsService.list({ state: q.state as BillState | undefined, kind: q.kind as BillKind | undefined, q: q.q });
  }

  @Get('bills/:id')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'One bill with its lines, payments, refunds, corrections and estimates' })
  bill(@Param() p: RevenueIdParam) {
    return this.billsService.view(p.id);
  }

  @Post('bills/:id/charges')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Add a charge the desk forgot to bill' })
  addCharge(@CurrentUser() user: unknown, @Param() p: RevenueIdParam, @Body() dto: MissedChargeDto) {
    return this.corrections.addMissed(actorOf(user), p.id, {
      code: dto.code,
      name: dto.name,
      category: dto.category as PriceCategory,
      qty: dto.qty,
      unitPrice: dto.unitPrice,
      reason: dto.reason,
    });
  }

  @Post('bills/:id/payments')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Record a payment; the receipt number is RC-0001 style' })
  recordPayment(@CurrentUser() user: unknown, @Param() p: RevenueIdParam, @Body() dto: PaymentDto) {
    return this.paymentsService.record(actorOf(user), p.id, { amount: dto.amount, mode: dto.mode as 'cash' | 'upi' | 'card', reference: dto.reference, kind: dto.kind as PaymentKind });
  }

  @Post('bills/:id/final/request')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Ask for the final bill of an ER or admission bill' })
  async requestFinal(@CurrentUser() user: unknown, @Param() p: RevenueIdParam) {
    return { requested: await this.final.request(actorOf(user), p.id) };
  }

  @Post('bills/:id/final/prepare')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Prepare the final bill' })
  prepareFinal(@CurrentUser() user: unknown, @Param() p: RevenueIdParam) {
    return this.final.prepare(actorOf(user), p.id);
  }

  @Post('bills/:id/settle')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Settle a bill whose balance is zero' })
  settle(@CurrentUser() user: unknown, @Param() p: RevenueIdParam) {
    return this.final.settle(actorOf(user), p.id);
  }

  @Post('bills/:id/corrections')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Ask for a change, reversal, discount or write-off (an admin\'s own request applies at once)' })
  requestCorrection(@CurrentUser() user: unknown, @Param() p: RevenueIdParam, @Body() dto: CorrectionDto) {
    return this.corrections.request(actorOf(user), {
      billId: p.id,
      lineId: dto.lineId,
      kind: dto.kind as CorrectionKind,
      amount: dto.amount,
      qty: dto.qty,
      unitPrice: dto.unitPrice,
      percent: dto.percent,
      reason: dto.reason,
    });
  }

  @Post('bills/:id/refund')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Ask to refund what the final bill owes' })
  requestRefund(@CurrentUser() user: unknown, @Param() p: RevenueIdParam) {
    return this.refunds.request(actorOf(user), p.id);
  }

  // ---------- estimates ----------

  @Get('estimates/:billId')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'The estimate of a bill' })
  estimate(@Param() p: BillIdParam) {
    return this.estimates.get(p.billId);
  }

  @Put('estimates/:id')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Change the days or extra lines of an estimate' })
  editEstimate(@CurrentUser() user: unknown, @Param() p: RevenueIdParam, @Body() dto: EstimateEditDto) {
    return this.estimates.edit(actorOf(user), p.id, { days: dto.days, extra: dto.extra?.map((l) => ({ name: l.name, amount: l.amount })) });
  }

  // ---------- payments and refunds ----------

  @Get('payments')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'A clinic day\'s payments, newest first' })
  payments(@Query() q: PaymentsQueryDto) {
    return this.paymentsService.list({ day: q.day });
  }

  @Post('payments/:id/cancel')
  @Roles(...REV_ADMIN)
  @ApiOperation({ summary: 'Cancel a payment (admin)' })
  cancelPayment(@CurrentUser() user: unknown, @Param() p: RevenueIdParam, @Body() dto: CancelPaymentDto) {
    return this.paymentsService.cancel(actorOf(user), p.id, dto.reason);
  }

  @Get('payments/:id/receipt')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'What the receipt prints' })
  receipt(@Param() p: RevenueIdParam) {
    return this.paymentsService.receipt(p.id);
  }

  @Post('refunds/:id/pay')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Pay an approved refund' })
  payRefund(@CurrentUser() user: unknown, @Param() p: RevenueIdParam, @Body() dto: RefundPayDto) {
    return this.refunds.pay(actorOf(user), p.id, { mode: dto.mode, reference: dto.reference });
  }

  // ---------- price list and settings ----------

  @Get('price-list')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'The price list' })
  priceList(@Query() q: PriceListQueryDto) {
    return this.prices.list({ category: q.category, q: q.q });
  }

  @Put('price-list')
  @Roles(...REV_ADMIN)
  @ApiOperation({ summary: 'Create or change one price (admin)' })
  savePrice(@CurrentUser() user: unknown, @Body() dto: PriceItemDto) {
    return this.prices.upsert(actorOf(user), dto);
  }

  @Get('settings')
  @Roles(...REV_DESK)
  @ApiOperation({ summary: 'Settings → Revenue' })
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...REV_ADMIN)
  @ApiOperation({ summary: 'Change Settings → Revenue (admin)' })
  saveSettings(@CurrentUser() user: unknown, @Body() body: Record<string, unknown>) {
    return this.settings.save(actorOf(user), body);
  }

  // ---------- running total ----------

  @Get('patients/:id/total')
  @Roles(...REV_TOTALS)
  @ApiOperation({ summary: 'A patient\'s running total and what they have paid' })
  patientTotal(@Param() p: RevenueIdParam) {
    return this.billsService.patientTotal(p.id);
  }
}
