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
import { TasksAlertsService } from './tasks-alerts.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Tasks & Clinical Alerts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tasks-alerts')
export class TasksAlertsController {
  constructor(private readonly tasksService: TasksAlertsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of tasks and clinical alerts' })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'category', required: false })
  async findAll(
    @Query('type') type?: string,
    @Query('priority') priority?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
  ) {
    return this.tasksService.findAll({ type, priority, status, category });
  }

  @Get('critical')
  @ApiOperation({ summary: 'Get active critical alerts' })
  async getCriticalAlerts() {
    return this.tasksService.getCriticalAlerts();
  }

  @Post()
  @ApiOperation({ summary: 'Create a new task or alert' })
  async create(@Body() body: any) {
    return this.tasksService.create(body);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Toggle task status between Pending and Completed' })
  async toggleStatus(@Param('id') id: string) {
    return this.tasksService.toggleStatus(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Set specific status on task/alert' })
  async updateStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.tasksService.updateStatus(id, status);
  }
}
