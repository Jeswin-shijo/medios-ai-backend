// The reception kiosk's settings live in the `reception` section of the hospital
// settings document. Stored values are untrusted, so every read goes through
// resolveReceptionSettings.

export interface ReceptionSettings {
  methods: { upi: boolean; cash: boolean; card: boolean };
  /** The doctor shown first / used when a patient is not asked to choose. Empty = first active doctor. */
  defaultDoctorId: string;
  upiPayeeName: string;
  /** Public web address used for tracking links in SMS, no trailing slash. Empty = none. */
  trackingBaseUrl: string;
  /** Seconds of no touching before the kiosk returns to its start screen. */
  idleSeconds: number;
  slipFooter: string;
}

export const DEFAULT_RECEPTION_SETTINGS: ReceptionSettings = {
  methods: { upi: true, cash: true, card: true },
  defaultDoctorId: '',
  upiPayeeName: '',
  trackingBaseUrl: '',
  idleSeconds: 60,
  slipFooter: 'Please wait for your token number. Thank you!',
};

const MAX_TEXT = 200;

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : fallback;
}

function baseUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().slice(0, MAX_TEXT);
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return raw.replace(/\/+$/, '');
}

export function resolveReceptionSettings(raw: unknown): ReceptionSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const m = (s.methods && typeof s.methods === 'object' ? s.methods : {}) as Record<string, unknown>;
  const d = DEFAULT_RECEPTION_SETTINGS;
  const flag = (v: unknown, fallback: boolean) => (v === true ? true : v === false ? false : fallback);
  const idle = Number(s.idleSeconds);

  return {
    methods: { upi: flag(m.upi, d.methods.upi), cash: flag(m.cash, d.methods.cash), card: flag(m.card, d.methods.card) },
    defaultDoctorId: text(s.defaultDoctorId, d.defaultDoctorId),
    upiPayeeName: text(s.upiPayeeName, d.upiPayeeName),
    trackingBaseUrl: baseUrl(s.trackingBaseUrl),
    idleSeconds: Number.isFinite(idle) ? Math.min(Math.max(Math.round(idle), 30), 300) : d.idleSeconds,
    slipFooter: typeof s.slipFooter === 'string' ? text(s.slipFooter, d.slipFooter) : d.slipFooter,
  };
}
