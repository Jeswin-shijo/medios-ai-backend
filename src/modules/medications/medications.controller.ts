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
import { MedicationsService } from './medications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Medications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('medications')
export class MedicationsController {
  constructor(private readonly medicationsService: MedicationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get medications with optional patient UHID and status filter' })
  @ApiQuery({ name: 'uhid', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['All', 'Active', 'Paused', 'Stopped', 'Completed'] })
  async findAll(
    @Query('uhid') uhid?: string,
    @Query('status') status?: string,
  ) {
    return this.medicationsService.findAll({ uhid, status });
  }

  @Post()
  @ApiOperation({ summary: 'Add a new medication to patient record' })
  async create(@Body() body: any) {
    return this.medicationsService.create(body);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update medication status (Active, Paused, Stopped, Completed)' })
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.medicationsService.updateStatus(id, status);
  }

  @Get('adherence/:uhid')
  @ApiOperation({ summary: 'Get medication adherence analytics for patient' })
  async getAdherence(@Param('uhid') uhid: string) {
    return this.medicationsService.getAdherence(uhid);
  }
}
