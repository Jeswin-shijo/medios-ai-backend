import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';
import { parseIsoDay } from '../../common/utils/clinic-time';

@ApiTags('Billing & Invoices')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /**
   * R43: open to every signed-in role so the CareSync mobile app's live load keeps working,
   * but only admin and front desk see invoices; every other role gets an empty list (200).
   */
  @Get('invoices')
  @ApiOperation({ summary: 'Get list of invoices with filters (admin and front desk; [] for other roles)' })
  @ApiQuery({ name: 'uhid', required: false })
  @ApiQuery({ name: 'status', required: false })
  async findAll(
    @CurrentUser() user: { role?: UserRole } | null,
    @Query('uhid') uhid?: string,
    @Query('status') status?: string,
  ) {
    if (user?.role !== UserRole.ADMIN && user?.role !== UserRole.STAFF) return [];
    return this.billingService.findAll({ uhid, status });
  }

  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @Get('invoices/:id')
  @ApiOperation({ summary: 'Get invoice by ID' })
  async findOne(@Param('id') id: string) {
    return this.billingService.findOne(id);
  }

  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @Post('invoices')
  @ApiOperation({ summary: 'Create a new invoice' })
  async create(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.billingService.create({ ...body, createdBy: body.createdBy || userName });
  }

  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @Patch('invoices/:id/pay')
  @ApiOperation({ summary: 'Record payment for invoice' })
  async recordPayment(
    @Param('id') id: string,
    @Body('amount') amount: number,
    @Body('paymentMode') paymentMode?: string,
  ) {
    return this.billingService.recordPayment(id, amount, paymentMode);
  }

  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @Patch('invoices/:id/notes')
  @ApiOperation({ summary: 'Update the notes on an invoice' })
  async updateNotes(@Param('id') id: string, @Body('notes') notes: string) {
    return this.billingService.updateNotes(id, notes ?? '');
  }

  @Roles(UserRole.ADMIN, UserRole.STAFF)
  @Get('stats')
  @ApiOperation({ summary: 'Get billing financial overview stats' })
  @ApiQuery({ name: 'date', required: false, description: 'Day for todayRevenue, YYYY-MM-DD (default today)' })
  async getStats(@Query('date') date?: string) {
    return this.billingService.getStats(parseIsoDay(date));
  }
}
