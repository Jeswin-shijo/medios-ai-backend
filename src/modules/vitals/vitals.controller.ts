import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { VitalsService } from './vitals.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Vitals & Trends')
@ApiBearerAuth()
@Controller('vitals')
export class VitalsController {
  constructor(private readonly vitalsService: VitalsService) {}

  @Get(':uhid')
  @ApiOperation({ summary: 'Get vital history and trends for patient' })
  @ApiQuery({ name: 'range', required: false, enum: ['1M', '3M', '6M', '1Y', 'All'] })
  async findByPatient(
    @Param('uhid') uhid: string,
    @Query('range') range?: string,
  ) {
    return this.vitalsService.findByPatient(uhid, range);
  }

  @Get(':uhid/latest')
  @ApiOperation({ summary: 'Get most recent vitals reading for patient' })
  async getLatest(@Param('uhid') uhid: string) {
    return this.vitalsService.getLatest(uhid);
  }

  @Post()
  @ApiOperation({ summary: 'Log a new vitals measurement' })
  async create(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.vitalsService.create({ ...body, recordedBy: body.recordedBy || userName });
  }
}
