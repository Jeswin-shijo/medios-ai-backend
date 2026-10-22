import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { parseIsoDay } from '../../common/utils/clinic-time';

@ApiTags('Billing & Invoices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get('invoices')
  @ApiOperation({ summary: 'Get list of invoices with filters' })
  @ApiQuery({ name: 'uhid', required: false })
  @ApiQuery({ name: 'status', required: false })
  async findAll(
    @Query('uhid') uhid?: string,
    @Query('status') status?: string,
  ) {
    return this.billingService.findAll({ uhid, status });
  }

  @Get('invoices/:id')
  @ApiOperation({ summary: 'Get invoice by ID' })
  async findOne(@Param('id') id: string) {
    return this.billingService.findOne(id);
  }

  @Post('invoices')
  @ApiOperation({ summary: 'Create a new invoice' })
  async create(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.billingService.create({ ...body, createdBy: body.createdBy || userName });
  }

  @Patch('invoices/:id/pay')
  @ApiOperation({ summary: 'Record payment for invoice' })
  async recordPayment(
    @Param('id') id: string,
    @Body('amount') amount: number,
    @Body('paymentMode') paymentMode?: string,
  ) {
    return this.billingService.recordPayment(id, amount, paymentMode);
  }

  @Patch('invoices/:id/notes')
  @ApiOperation({ summary: 'Update the notes on an invoice' })
  async updateNotes(@Param('id') id: string, @Body('notes') notes: string) {
    return this.billingService.updateNotes(id, notes ?? '');
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get billing financial overview stats' })
  @ApiQuery({ name: 'date', required: false, description: 'Day for todayRevenue, YYYY-MM-DD (default today)' })
  async getStats(@Query('date') date?: string) {
    return this.billingService.getStats(parseIsoDay(date));
  }
}
