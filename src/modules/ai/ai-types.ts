export type AiProviderName = 'none' | 'sample' | 'claude';
export type AiFeature = 'bedSuggestions';
export type AiFailure = 'off' | 'timeout' | 'invalid' | 'provider_error';

/** One structured question for the AI; each feature builds its own. */
export interface StructuredTask<T> {
  feature: AiFeature;
  /** System prompt. */
  instructions: string;
  /** Sent as JSON in the user turn. */
  input: Record<string, unknown>;
  /** JSON schema: additionalProperties:false everywhere; no minLength/maxLength/maxItems (the API rejects them). */
  schema: Record<string, unknown>;
  /** Returns null when the answer is invalid. */
  validate(raw: unknown): T | null;
  /** What the 'sample' provider returns. */
  sample(): T;
}

export type AiResult<T> =
  | { ok: true; value: T; sample: boolean; provider: AiProviderName; model: string; latencyMs: number }
  | { ok: false; failure: AiFailure; provider: AiProviderName; model: string; latencyMs: number; detail?: string };
