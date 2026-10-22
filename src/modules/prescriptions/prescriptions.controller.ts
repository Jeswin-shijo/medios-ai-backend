import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PrescriptionsService } from './prescriptions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Prescriptions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('prescriptions')
export class PrescriptionsController {
  constructor(private readonly prescriptionsService: PrescriptionsService) {}

  @Get()
  @ApiOperation({ summary: 'Get prescriptions for a patient' })
  @ApiQuery({ name: 'uhid', required: true })
  async findByPatient(@Query('uhid') uhid: string) {
    return this.prescriptionsService.findByPatient(uhid);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get prescription by ID' })
  async findOne(@Param('id') id: string) {
    return this.prescriptionsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create new prescription' })
  async create(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.prescriptionsService.create({ ...body, doctor: body.doctor || userName });
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update prescription' })
  async update(@Param('id') id: string, @Body() updates: any) {
    return this.prescriptionsService.update(id, updates);
  }

  @Post('check-interactions')
  @ApiOperation({ summary: 'Check drug interactions between medicines' })
  async checkInteractions(@Body('medicines') medicines: string[]) {
    return this.prescriptionsService.checkInteractions(medicines || []);
  }

  @Get('alternatives/:medicine')
  @ApiOperation({ summary: 'Get drug alternatives and generics' })
  async getAlternatives(@Param('medicine') medicine: string) {
    return this.prescriptionsService.getAlternatives(medicine);
  }
}
