import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TimelineService } from './timeline.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Patient Timeline')
@ApiBearerAuth()
@Controller('timeline')
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get(':uhid')
  @ApiOperation({ summary: 'Get longitudinal encounter timeline for patient' })
  @ApiQuery({ name: 'category', required: false })
  async findByPatient(
    @Param('uhid') uhid: string,
    @Query('category') category?: string,
  ) {
    return this.timelineService.findByPatient(uhid, category);
  }

  @Post()
  @ApiOperation({ summary: 'Add a new timeline milestone or event' })
  async create(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.timelineService.create({ ...body, doctor: body.doctor || userName });
  }
}
