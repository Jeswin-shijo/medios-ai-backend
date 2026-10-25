import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AI_PROVIDER, AiProvider, NoAiProvider, SampleAiProvider } from './ai-provider';
import { ClaudeAiProvider } from './providers/claude.provider';

@Module({
  imports: [SettingsModule],
  controllers: [AiController],
  providers: [
    AiService,
    {
      // AI_PROVIDER picks who answers; validated at startup (env.validation.ts).
      provide: AI_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AiProvider => {
        switch (config.get<string>('ai.provider')) {
          case 'claude':
            return new ClaudeAiProvider({ apiKey: config.get<string>('ai.apiKey'), model: config.get<string>('ai.model') });
          case 'sample':
            return new SampleAiProvider();
          default:
            return new NoAiProvider();
        }
      },
    },
  ],
  exports: [AiService],
})
export class AiModule {}
