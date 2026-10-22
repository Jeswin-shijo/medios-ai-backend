import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/schemas/user.schema';

@ApiTags('Settings & Hospital Configuration')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get hospital settings and doctor profile configuration' })
  async getSettings() {
    return this.settingsService.getSettings();
  }

  @Put()
  @Roles(UserRole.ADMIN, UserRole.DOCTOR)
  @ApiOperation({ summary: 'Update hospital settings, AI parameters, or clinical preferences' })
  async updateSettings(@Body() body: any) {
    return this.settingsService.updateSettings(body);
  }
}
