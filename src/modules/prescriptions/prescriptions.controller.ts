import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PrescriptionsService } from './prescriptions.service';
import { actorOf } from '../beds/actor';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';

@ApiTags('Prescriptions')
@ApiBearerAuth()
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
  @Roles(UserRole.DOCTOR)
  @ApiOperation({ summary: 'Create new prescription' })
  async create(@Body() body: any, @CurrentUser() user: any) {
    return this.prescriptionsService.create({ ...body, doctor: body.doctor || user.name }, actorOf(user));
  }

  @Put(':id')
  @Roles(UserRole.DOCTOR)
  @ApiOperation({ summary: 'Update prescription' })
  async update(@Param('id') id: string, @Body() updates: any, @CurrentUser() user: any) {
    return this.prescriptionsService.update(id, updates, actorOf(user));
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
