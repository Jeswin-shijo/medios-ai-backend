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
import { ConsultationsService } from './consultations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Consultations & EMR')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('consultations')
export class ConsultationsController {
  constructor(private readonly consultationsService: ConsultationsService) {}

  @Get()
  @ApiOperation({ summary: 'Get consultations for patient by UHID' })
  @ApiQuery({ name: 'uhid', required: true })
  async findByPatient(@Query('uhid') uhid: string) {
    return this.consultationsService.findByPatient(uhid);
  }

  @Get('soap/:uhid')
  @ApiOperation({ summary: 'Get latest SOAP note for patient, or an unsaved blank draft' })
  async getSoap(@Param('uhid') uhid: string, @CurrentUser('name') userName: string) {
    return this.consultationsService.getLatestSoap(uhid, userName);
  }

  @Post('soap')
  @ApiOperation({ summary: 'Save a SOAP note (updates the note named by id, else creates one)' })
  async saveSoap(@Body() body: any, @CurrentUser('name') userName: string) {
    return this.consultationsService.saveSoap(body, userName);
  }

  @Get('icd10')
  @ApiOperation({ summary: 'Search ICD-10 diagnostic codes' })
  @ApiQuery({ name: 'q', required: false })
  async searchIcd10(@Query('q') q?: string) {
    return this.consultationsService.searchIcd10(q);
  }

  @Post('ai-suggestions')
  @ApiOperation({ summary: 'Get AI CDSS clinical suggestions, investigations, and treatment' })
  async generateAiSuggestions(@Body('symptoms') symptoms: string) {
    return this.consultationsService.generateAiSuggestions(symptoms || '');
  }
}
