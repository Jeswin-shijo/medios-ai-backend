// The token queue's settings live in the `queue` section of the hospital settings
// document (edited through PUT /settings like any other section). Stored values are
// untrusted, so every read goes through resolveQueueSettings.

export interface QueueSettings {
  /** Where tokens are called to: consultation rooms, doctors' cabins, counters. */
  counters: string[];
  /** Printed before the number on the display and slips, e.g. "A" → "A12". */
  tokenPrefix: string;
  /**
   * Show "Priya S." next to each token on the waiting-room display. Off by default:
   * a display in a public room shows token numbers only.
   */
  showNamesOnDisplay: boolean;
  /** Chime and speak "Token 12, please go to Room 1" on the display when a token is called. */
  announce: boolean;
  /** How many waiting tokens the display lists as "next". */
  upcomingOnDisplay: number;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  counters: ['Consultation Room'],
  tokenPrefix: '',
  showNamesOnDisplay: false,
  announce: true,
  upcomingOnDisplay: 6,
};

export const MAX_COUNTERS = 12;
const COUNTER_NAME = /^[\p{L}\p{N} .,'()&/-]{1,30}$/u;
const PREFIX = /^[A-Za-z0-9-]{0,4}$/;

export function resolveQueueSettings(raw: unknown): QueueSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_QUEUE_SETTINGS;

  const counters = Array.isArray(s.counters)
    ? [...new Set(s.counters.map((c) => String(c ?? '').trim()).filter((c) => COUNTER_NAME.test(c)))].slice(0, MAX_COUNTERS)
    : [];
  const upcoming = Number(s.upcomingOnDisplay);

  return {
    counters: counters.length ? counters : d.counters,
    tokenPrefix: typeof s.tokenPrefix === 'string' && PREFIX.test(s.tokenPrefix.trim()) ? s.tokenPrefix.trim().toUpperCase() : d.tokenPrefix,
    showNamesOnDisplay: s.showNamesOnDisplay === true,
    announce: s.announce !== false,
    upcomingOnDisplay: Number.isFinite(upcoming) ? Math.min(Math.max(Math.round(upcoming), 0), 12) : d.upcomingOnDisplay,
  };
}

/** "Priya Sharma" → "Priya S.": enough for a patient to recognise themselves, not more. */
export function displayName(fullName: string): string {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
