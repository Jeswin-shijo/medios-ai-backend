import type { WardType } from '../beds/bed-types';

export const PRICE_CATEGORIES = ['consultation', 'er', 'bed', 'nursing', 'lab', 'imaging', 'pharmacy', 'procedure', 'consumables', 'other'] as const;
export type PriceCategory = (typeof PRICE_CATEGORIES)[number];

export type WardGroup = 'general' | 'private' | 'critical';
export const WARD_GROUPS: WardGroup[] = ['general', 'private', 'critical'];

const GROUP_OF: Record<WardType, WardGroup | null> = {
  general: 'general',
  paediatric: 'general',
  maternity: 'general',
  private: 'private',
  twin: 'private',
  deluxe: 'private',
  isolation: 'private',
  icu: 'critical',
  hdu: 'critical',
  emergency: null,
};

/** The billing group of a ward type; null for the emergency ward (no deposit, no stay). */
export const wardGroupOf = (type: WardType): WardGroup | null => GROUP_OF[type] ?? null;

/** Advance deposit per group, whole rupees. */
export const DEFAULT_DEPOSITS: Record<WardGroup, number> = { general: 10000, private: 25000, critical: 50000 };

/** Default stay in days, used for the estimate (emergency has none). */
export const DEFAULT_STAY: Record<WardType, number> = {
  general: 3, paediatric: 3, maternity: 3, private: 3, twin: 3, deluxe: 3, isolation: 3, icu: 3, hdu: 2, emergency: 0,
};

/** Daily allowance for tests and medicines in the estimate, whole rupees (emergency has none). */
export const DEFAULT_ALLOWANCE: Record<WardType, number> = {
  general: 1500, paediatric: 1500, maternity: 1500, private: 2500, twin: 2500, deluxe: 2500, isolation: 2500, icu: 6000, hdu: 4000, emergency: 0,
};

export const ESTIMATE_LOW = 0.9;
export const ESTIMATE_HIGH = 1.2;
/** A top-up is asked for when this share of payments is used. */
export const TOPUP_THRESHOLD = 0.8;

export const DEFAULT_CLOCKS = { final: 60, topup: 240, refund: 2880 };

export const labCode = (test: string): string => `lab:${test}`;
export const medCode = (product: string): string => `med:${product}`;
export const procCode = (key: string): string => `proc:${key}`;
export const consultCode = (priority: 'stat' | 'urgent' | 'routine'): string => `consult:${priority}`;
export const nursingCode = (group: WardGroup): string => `nursing:${group}`;

export const PRICE_CODE_PATTERN = /^[a-z]+:[a-z0-9.-]+$/;
