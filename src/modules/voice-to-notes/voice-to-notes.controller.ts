import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { VoiceToNotesService } from './voice-to-notes.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('Voice to Notes (Ambient AI Scribe)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('voice-to-notes')
export class VoiceToNotesController {
  constructor(private readonly voiceService: VoiceToNotesService) {}

  @Post('transcribe')
  @ApiOperation({ summary: 'Transcribe medical encounter audio into diarized text' })
  async transcribe(@Body() body: { audioUrl?: string; rawText?: string; language?: string }) {
    return this.voiceService.transcribeAudio(body);
  }

  @Post('generate-soap')
  @ApiOperation({ summary: 'Convert conversation transcript into structured SOAP clinical note' })
  async generateSoap(@Body('transcript') transcript: string) {
    return this.voiceService.generateSoapFromTranscript(transcript || '');
  }

  @Get('templates')
  @ApiOperation({ summary: 'Get clinical dictation templates' })
  async getTemplates() {
    return this.voiceService.getTemplates();
  }
}
