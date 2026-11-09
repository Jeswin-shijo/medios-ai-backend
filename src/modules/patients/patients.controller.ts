import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PatientsService } from './patients.service';
import { CreatePatientDto } from './dto/create-patient.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';

@ApiTags('Patients')
@ApiBearerAuth()
@Controller('patients')
export class PatientsController {
  constructor(private readonly patientsService: PatientsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of patients with search and filters' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['All', 'Today', 'Admitted', 'Follow-up', 'Discharged', 'Deceased', 'Left without discharge'] })
  @ApiQuery({ name: 'visitType', required: false, enum: ['All', 'OPD', 'IPD'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  async findAll(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('visitType') visitType?: string,
    @Query('department') department?: string,
    @Query('limit') limit?: number,
    @Query('skip') skip?: number,
  ) {
    return this.patientsService.findAll({ search, status, visitType, department, limit, skip });
  }

  @Get(':idOrUhid')
  @ApiOperation({ summary: 'Get single patient by MongoDB ID or UHID' })
  async findOne(@Param('idOrUhid') idOrUhid: string) {
    return this.patientsService.findOne(idOrUhid);
  }

  @Post()
  @ApiOperation({ summary: 'Register a new patient' })
  async create(@Body() createPatientDto: CreatePatientDto, @CurrentUser('name') userName: string) {
    return this.patientsService.create({ ...createPatientDto, doctor: createPatientDto.doctor || userName });
  }

  @Put(':idOrUhid')
  @ApiOperation({ summary: 'Update patient information' })
  async update(
    @Param('idOrUhid') idOrUhid: string,
    @Body() updates: Partial<CreatePatientDto>,
  ) {
    return this.patientsService.update(idOrUhid, updates);
  }

  @Delete(':idOrUhid')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete patient record' })
  async remove(@Param('idOrUhid') idOrUhid: string) {
    return this.patientsService.remove(idOrUhid);
  }
}
