import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OpdService } from './opd.service';
import {
  CreateDepartmentDto, CreateDoctorDto, DepartmentsQueryDto, DoctorsQueryDto, SuggestPrefixQueryDto, UpdateDepartmentDto, UpdateDoctorDto,
} from './dto/opd.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';

const OPD_READERS = [UserRole.ADMIN, UserRole.DOCTOR, UserRole.NURSE, UserRole.STAFF];

@ApiTags('OPD Catalog')
@ApiBearerAuth()
@Controller('opd')
export class OpdController {
  constructor(private readonly opd: OpdService) {}

  @Get('departments')
  @Roles(...OPD_READERS)
  @ApiOperation({ summary: 'Outpatient departments in display order' })
  departments(@Query() query: DepartmentsQueryDto) {
    return this.opd.listDepartments({ activeOnly: query.active === 'true' });
  }

  @Post('departments')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Add an outpatient department' })
  createDepartment(@Body() dto: CreateDepartmentDto) {
    return this.opd.createDepartment(dto);
  }

  @Patch('departments/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Change a department (its code stays)' })
  updateDepartment(@Param('id') id: string, @Body() dto: UpdateDepartmentDto) {
    return this.opd.updateDepartment(id, dto);
  }

  @Get('doctors')
  @Roles(...OPD_READERS)
  @ApiOperation({ summary: 'OP doctors, optionally of one department or only active ones' })
  doctors(@Query() query: DoctorsQueryDto) {
    return this.opd.listDoctors({ departmentCode: query.department, activeOnly: query.active === 'true' });
  }

  // Declared before `doctors/:id` routes so "suggest-prefix" is never read as an id.
  @Get('doctors/suggest-prefix')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Free token letters for a new doctor in a department' })
  async suggestPrefix(@Query() query: SuggestPrefixQueryDto) {
    return { tokenPrefix: await this.opd.suggestPrefix(query.department) };
  }

  @Post('doctors')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Add an OP doctor' })
  createDoctor(@Body() dto: CreateDoctorDto) {
    return this.opd.createDoctor(dto);
  }

  @Patch('doctors/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Change an OP doctor' })
  updateDoctor(@Param('id') id: string, @Body() dto: UpdateDoctorDto) {
    return this.opd.updateDoctor(id, dto);
  }
}
