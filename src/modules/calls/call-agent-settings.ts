// The AI call agent's settings live in the `callAgent` section of the hospital
// settings document, so the web app edits them like any other settings section.
// Stored values are untrusted (PUT /settings takes free-form sections): every read
// goes through resolveCallAgentSettings, which falls back to the defaults.

/** How the simulated provider's "patient" answers (development only). */
export const SIMULATED_RESPONSES = ['random', 'positive', 'reschedule', 'callback', 'cancel', 'no_answer', 'escalate', 'do_not_call'] as const;
export type SimulatedResponse = (typeof SIMULATED_RESPONSES)[number];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface CallAgentSettings {
  /** Place confirmation calls automatically before appointments. */
  autoConfirm: boolean;
  confirmHoursBefore: number;
  /** No call is placed outside this window (local time, "HH:MM"). */
  callingHoursStart: string;
  callingHoursEnd: string;
  maxAttempts: number;
  retryMinutes: number;
  agentName: string;
  language: string;
  /** Bookable sessions, e.g. "09:00-13:00, 14:00-17:00". */
  clinicSessions: string;
  slotMinutes: number;
  closedDays: string[];
  simulatedResponse: SimulatedResponse;
  /** Inbound calls: callers may book, move, confirm and cancel; off means the agent takes a message instead. */
  inboundChanges: boolean;
  /**
   * The API's public address (e.g. https://medios.example.com), used only to show
   * the full webhook and tool URLs to paste into SnapServe. Those URLs add /api.
   */
  publicApiUrl: string;
}

export const DEFAULT_CALL_AGENT_SETTINGS: CallAgentSettings = {
  autoConfirm: false,
  confirmHoursBefore: 24,
  callingHoursStart: '09:00',
  callingHoursEnd: '20:00',
  maxAttempts: 3,
  retryMinutes: 30,
  agentName: 'Asha',
  language: 'English',
  clinicSessions: '09:00-13:00, 14:00-17:00',
  slotMinutes: 30,
  closedDays: [],
  simulatedResponse: 'random',
  inboundChanges: true,
  publicApiUrl: '',
};

const HH_MM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Minutes since midnight for "HH:MM"; null when malformed. */
export const hhmm = (value: string): number | null => {
  const m = HH_MM.exec(String(value ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** "09:00-13:00, 14:00-17:00" → [[540, 780], [840, 1020]]; malformed parts are dropped. */
export function parseSessions(value: string): [number, number][] {
  return String(value ?? '')
    .split(',')
    .map((part) => part.split('-').map((t) => hhmm(t)))
    .filter((pair): pair is [number, number] => pair.length === 2 && pair[0] !== null && pair[1] !== null && pair[0] < pair[1]);
}

const int = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
};

const text = (value: unknown, fallback: string, maxLength = 40) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;

/**
 * An https address without trailing slashes or a trailing /api (the API's own
 * addresses end in /api, and the URLs shown add it): "" when not https.
 */
export function publicApiUrl(value: unknown): string {
  const url = String(value ?? '').trim();
  if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(url)) return '';
  return url.replace(/\/+$/, '').replace(/\/api$/i, '').replace(/\/+$/, '');
}

export function resolveCallAgentSettings(raw: unknown): CallAgentSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CALL_AGENT_SETTINGS;

  let start = hhmm(String(s.callingHoursStart)) !== null ? String(s.callingHoursStart) : d.callingHoursStart;
  let end = hhmm(String(s.callingHoursEnd)) !== null ? String(s.callingHoursEnd) : d.callingHoursEnd;
  if (hhmm(start)! >= hhmm(end)!) [start, end] = [d.callingHoursStart, d.callingHoursEnd];

  return {
    autoConfirm: s.autoConfirm === true,
    confirmHoursBefore: int(s.confirmHoursBefore, d.confirmHoursBefore, 2, 72),
    callingHoursStart: start,
    callingHoursEnd: end,
    maxAttempts: int(s.maxAttempts, d.maxAttempts, 1, 5),
    retryMinutes: int(s.retryMinutes, d.retryMinutes, 10, 240),
    agentName: text(s.agentName, d.agentName, 24),
    language: text(s.language, d.language),
    clinicSessions: parseSessions(String(s.clinicSessions ?? '')).length ? String(s.clinicSessions) : d.clinicSessions,
    slotMinutes: int(s.slotMinutes, d.slotMinutes, 10, 120),
    closedDays: Array.isArray(s.closedDays) ? s.closedDays.filter((day) => WEEKDAYS.includes(String(day))).map(String) : d.closedDays,
    simulatedResponse: SIMULATED_RESPONSES.includes(s.simulatedResponse as SimulatedResponse) ? (s.simulatedResponse as SimulatedResponse) : d.simulatedResponse,
    inboundChanges: s.inboundChanges !== false,
    publicApiUrl: publicApiUrl(s.publicApiUrl),
  };
}

/** Whether `at` falls inside the calling window (local time). */
export function withinCallingHours(at: Date, cfg: CallAgentSettings): boolean {
  const minutes = at.getHours() * 60 + at.getMinutes();
  return minutes >= hhmm(cfg.callingHoursStart)! && minutes < hhmm(cfg.callingHoursEnd)!;
}

/** `at` itself when calls are allowed then, otherwise the start of the next calling window. */
export function nextCallingTime(at: Date, cfg: CallAgentSettings): Date {
  if (withinCallingHours(at, cfg)) return at;
  const start = hhmm(cfg.callingHoursStart)!;
  const next = new Date(at);
  if (at.getHours() * 60 + at.getMinutes() >= start) next.setDate(next.getDate() + 1);
  next.setHours(Math.floor(start / 60), start % 60, 0, 0);
  return next;
}
