import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AppointmentsService } from './appointments.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get appointments with date/status filters' })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'uhid', required: false })
  @ApiQuery({ name: 'search', required: false })
  async findAll(
    @Query('date') date?: string,
    @Query('status') status?: string,
    @Query('uhid') uhid?: string,
    @Query('search') search?: string,
  ) {
    return this.appointmentsService.findAll({ date, status, uhid, search });
  }

  @Get('today')
  @ApiOperation({ summary: "Get today's live queue appointments" })
  async findToday() {
    return this.appointmentsService.findToday();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single appointment by ID' })
  async findOne(@Param('id') id: string) {
    return this.appointmentsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Schedule a new appointment' })
  async create(@Body() body: any) {
    return this.appointmentsService.create(body);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update appointment status' })
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.appointmentsService.updateStatus(id, status);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update appointment details' })
  async update(@Param('id') id: string, @Body() updates: any) {
    return this.appointmentsService.update(id, updates);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel/Delete appointment' })
  async remove(@Param('id') id: string) {
    return this.appointmentsService.remove(id);
  }
}
