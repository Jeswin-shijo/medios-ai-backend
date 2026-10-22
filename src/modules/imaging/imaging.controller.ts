import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ImagingService } from './imaging.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';

@ApiTags('Imaging & RIS')
@ApiBearerAuth()
@Controller('imaging')
export class ImagingController {
  constructor(private readonly imagingService: ImagingService) {}

  @Get()
  @ApiOperation({ summary: 'Get imaging studies with modality/patient filters' })
  @ApiQuery({ name: 'uhid', required: false })
  @ApiQuery({ name: 'modality', required: false })
  async findAll(
    @Query('uhid') uhid?: string,
    @Query('modality') modality?: string,
  ) {
    return this.imagingService.findAll({ uhid, modality });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single imaging study with DICOM / PACS slices' })
  async findOne(@Param('id') id: string) {
    return this.imagingService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a new imaging study record' })
  async create(@Body() body: any) {
    return this.imagingService.create(body);
  }

  @Patch(':id/report')
  @Roles(UserRole.DOCTOR)
  @ApiOperation({ summary: 'Submit radiologist report for study' })
  async updateReport(
    @Param('id') id: string,
    @Body() reportData: any,
    @CurrentUser('name') userName: string,
  ) {
    return this.imagingService.updateReport(id, { ...reportData, reportedBy: reportData.reportedBy || userName });
  }
}
