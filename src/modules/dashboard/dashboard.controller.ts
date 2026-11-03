import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';
import { UserRole } from '../users/schemas/user.schema';
import { parseIsoDay } from '../../common/utils/clinic-time';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Get aggregated dashboard KPIs, schedule, patient flow & alerts for a day' })
  @ApiQuery({ name: 'date', required: false, description: 'YYYY-MM-DD (default today)' })
  async getDashboardStats(@CurrentUser() user: { role?: UserRole }, @Query('date') date?: string) {
    return this.dashboardService.getDashboardStats(parseIsoDay(date), user?.role);
  }
}
