import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { parseIsoDay } from '../../common/utils/clinic-time';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get aggregated dashboard KPIs, schedule, patient flow & alerts for a day' })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD (default today)' })
  async getDashboardStats(@Query('date') date?: string) {
    return this.dashboardService.getDashboardStats(parseIsoDay(date));
  }
}
