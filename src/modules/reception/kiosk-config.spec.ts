process.env.TZ = 'Asia/Kolkata';
import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_RECEPTION_SETTINGS, ReceptionSettings } from './reception-settings';
import { buildKioskConfig } from './kiosk.controller';

const base = (over: Partial<Parameters<typeof buildKioskConfig>[0]> = {}) =>
  buildKioskConfig({
    kioskName: 'Front kiosk',
    printSlips: true,
    hospital: { name: "St. Mary's", address: 'Nagercoil', phone: '04652 000000' },
    reception: DEFAULT_RECEPTION_SETTINGS,
    paymentProvider: 'sample',
    smsProvider: 'sample',
    publicWebUrl: '',
    now: new Date('2026-09-26T05:00:00Z'),
    ...over,
  });

describe('buildKioskConfig', () => {
  test('upi and card are off without a payment provider even when enabled in settings', () => {
    const config = base({ paymentProvider: 'none' });
    assert.deepEqual(config.methods, { upi: false, cash: true, card: false });
    assert.equal(config.sample.payments, false);
  });

  test('settings can still switch a method off with a provider present', () => {
    const reception: ReceptionSettings = { ...DEFAULT_RECEPTION_SETTINGS, methods: { upi: true, cash: false, card: false } };
    assert.deepEqual(base({ reception }).methods, { upi: true, cash: false, card: false });
    assert.equal(base().sample.payments, true);
  });

  test('find by phone needs an sms provider', () => {
    assert.equal(base().findByPhone, true);
    assert.equal(base({ smsProvider: 'none' }).findByPhone, false);
    assert.equal(base({ smsProvider: 'none' }).sample.sms, false);
  });

  test('tracking base falls back to PUBLIC_WEB_URL, setting first, else empty', () => {
    assert.equal(base({ publicWebUrl: 'https://web.example/' }).trackingBaseUrl, 'https://web.example');
    const reception = { ...DEFAULT_RECEPTION_SETTINGS, trackingBaseUrl: 'https://own.example' };
    assert.equal(base({ reception, publicWebUrl: 'https://web.example' }).trackingBaseUrl, 'https://own.example');
    assert.equal(base().trackingBaseUrl, '');
  });

  test('clinic block: day, India offset, server time', () => {
    const { clinic } = base();
    assert.equal(clinic.utcOffsetMinutes, 330);
    assert.equal(clinic.serverTime, '2026-09-26T05:00:00.000Z');
    assert.match(clinic.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});
