import { AiProviderName } from './ai-types';

// An AI provider answers one structured request. Which one runs is picked by AI_PROVIDER
// (see ai.module.ts); the AiService adds the timeout, validation and the Settings switch.

export const AI_PROVIDER = Symbol('AI_PROVIDER');

export interface AiCompletionRequest {
  instructions: string;
  input: Record<string, unknown>;
  schema: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  /** Returns the parsed JSON object the model produced. */
  complete(req: AiCompletionRequest): Promise<unknown>;
  check(): Promise<{ ok: boolean; detail: string }>;
}

export class NoAiProvider implements AiProvider {
  readonly name = 'none';
  readonly model = 'none';

  async complete(): Promise<unknown> {
    throw new Error('AI is off (AI_PROVIDER=none).');
  }

  async check() {
    return { ok: true, detail: 'AI is off (AI_PROVIDER=none).' };
  }
}

export class SampleAiProvider implements AiProvider {
  readonly name = 'sample';
  readonly model = 'sample';

  /** The service answers from the task's own sample(), so this is never called. */
  async complete(): Promise<unknown> {
    throw new Error('The sample provider does not call an AI service.');
  }

  async check() {
    return { ok: true, detail: 'Sample mode: no AI service is called.' };
  }
}
