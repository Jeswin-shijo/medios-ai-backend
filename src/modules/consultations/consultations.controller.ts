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
  @ApiOperation({ summary: 'Get active/latest SOAP note for patient' })
  async getSoap(@Param('uhid') uhid: string) {
    return this.consultationsService.getLatestSoap(uhid);
  }

  @Post('soap')
  @ApiOperation({ summary: 'Save or update SOAP note' })
  async saveSoap(@Body() body: any) {
    return this.consultationsService.saveSoap(body);
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
