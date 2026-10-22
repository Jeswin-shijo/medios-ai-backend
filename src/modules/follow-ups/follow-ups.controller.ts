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
import { FollowUpsService } from './follow-ups.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Follow-ups & Recalls')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('follow-ups')
export class FollowUpsController {
  constructor(private readonly followUpsService: FollowUpsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of scheduled follow-ups' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'uhid', required: false })
  async findAll(
    @Query('status') status?: string,
    @Query('date') date?: string,
    @Query('uhid') uhid?: string,
  ) {
    return this.followUpsService.findAll({ status, date, uhid });
  }

  @Post()
  @ApiOperation({ summary: 'Schedule a follow-up appointment' })
  async create(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.followUpsService.create({ ...body, assignedTo: body.assignedTo || userName });
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update follow-up status (Scheduled, Completed, Missed, Overdue)' })
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.followUpsService.updateStatus(id, status);
  }

  @Post(':id/send-reminder')
  @ApiOperation({ summary: 'Send automated WhatsApp/SMS recall reminder to patient' })
  async sendReminder(@Param('id') id: string) {
    return this.followUpsService.sendReminder(id);
  }
}
