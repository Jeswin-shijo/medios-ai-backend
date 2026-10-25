import Anthropic from '@anthropic-ai/sdk';
import { AiCompletionRequest, AiProvider } from '../ai-provider';

/** The slice of the Anthropic client used here, so tests can inject a fake. */
export interface AnthropicLike {
  beta: {
    messages: {
      create(body: any, options?: { signal?: AbortSignal }): PromiseLike<{ stop_reason?: string | null; content: any[] }>;
    };
  };
  models: { retrieve(model: string): PromiseLike<unknown> };
}

export interface ClaudeConfig {
  apiKey: string;
  model: string;
}

export class ClaudeAiProvider implements AiProvider {
  readonly name = 'claude';
  readonly model: string;
  private readonly client: AnthropicLike;

  constructor(cfg: ClaudeConfig, client?: AnthropicLike) {
    this.model = cfg.model;
    // No SDK retries: the service enforces its own timeout, and staff are waiting.
    this.client = client ?? (new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0 }) as unknown as AnthropicLike);
  }

  async complete(req: AiCompletionRequest): Promise<unknown> {
    const message = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: 16000,
        system: req.instructions,
        messages: [{ role: 'user', content: JSON.stringify(req.input) }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
        // If the model declines or is unavailable, the API retries on its default fallback.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal: req.signal },
    );
    if (message.stop_reason === 'refusal') throw new Error('AI declined the request (refusal)');
    const block = message.content.find((b) => b?.type === 'text');
    if (!block || typeof block.text !== 'string') throw new Error('AI returned no text');
    return JSON.parse(block.text);
  }

  async check() {
    try {
      await this.client.models.retrieve(this.model);
      return { ok: true, detail: `Connected: ${this.model}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
