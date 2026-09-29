import { Module } from '@nestjs/common';
import { VoiceToNotesService } from './voice-to-notes.service';
import { VoiceToNotesController } from './voice-to-notes.controller';

@Module({
  controllers: [VoiceToNotesController],
  providers: [VoiceToNotesService],
  exports: [VoiceToNotesService],
})
export class VoiceToNotesModule {}
