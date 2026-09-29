import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { LabReportsService } from './lab-reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Lab Reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('lab-reports')
export class LabReportsController {
  constructor(private readonly labReportsService: LabReportsService) {}

  @Get()
  @ApiOperation({ summary: 'Get lab reports with filters' })
  @ApiQuery({ name: 'uhid', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'status', required: false })
  async findAll(
    @Query('uhid') uhid?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    return this.labReportsService.findAll({ uhid, category, status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single lab report by ID' })
  async findOne(@Param('id') id: string) {
    return this.labReportsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create new lab report' })
  async create(@Body() body: any) {
    return this.labReportsService.create(body);
  }

  @Get('trends/:uhid')
  @ApiOperation({ summary: 'Get parameter longitudinal trends for patient' })
  async getTrends(@Param('uhid') uhid: string) {
    return this.labReportsService.getTrends(uhid);
  }
}
