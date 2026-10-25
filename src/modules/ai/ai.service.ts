import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service';
import { AI_PROVIDER, AiProvider } from './ai-provider';
import { AiFailure, AiProviderName, AiResult, StructuredTask } from './ai-types';

class TimeoutSignal extends Error {}

@Injectable()
export class AiService {
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
  ) {}

  async runStructured<T>(task: StructuredTask<T>): Promise<AiResult<T>> {
    const started = Date.now();
    const base = () => ({ provider: this.provider.name, model: this.provider.model, latencyMs: Date.now() - started });
    const fail = (failure: AiFailure, detail?: string): AiResult<T> => ({ ok: false, failure, ...base(), ...(detail ? { detail } : {}) });

    if (this.provider.name === 'none' || !(await this.featureOn(task.feature))) return fail('off');

    if (this.provider.name === 'sample') {
      const value = task.validate(task.sample());
      return value === null ? fail('invalid') : { ok: true, value, sample: true, ...base() };
    }

    const controller = new AbortController();
    const timeoutMs = this.config.get<number>('ai.timeoutMs') ?? 8000;
    let timer: NodeJS.Timeout;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutSignal());
      }, timeoutMs);
    });
    try {
      const raw = await Promise.race([
        this.provider.complete({ instructions: task.instructions, input: task.input, schema: task.schema, signal: controller.signal }),
        timedOut,
      ]);
      const value = task.validate(raw);
      return value === null ? fail('invalid') : { ok: true, value, sample: false, ...base() };
    } catch (err) {
      if (err instanceof TimeoutSignal || controller.signal.aborted) return fail('timeout');
      return fail('provider_error', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<{ provider: AiProviderName; model: string; features: { bedSuggestions: boolean } }> {
    return {
      provider: this.provider.name,
      model: this.provider.model,
      features: { bedSuggestions: this.provider.name !== 'none' && (await this.featureOn('bedSuggestions')) },
    };
  }

  async check(): Promise<{ provider: AiProviderName; ok: boolean; detail: string }> {
    return { provider: this.provider.name, ...(await this.provider.check()) };
  }

  private async featureOn(feature: string): Promise<boolean> {
    const settings = await this.settings.getSettings();
    return (settings.ai as Record<string, unknown> | undefined)?.[feature] !== false;
  }
}
