import 'reflect-metadata';
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  BillsQueryDto, CorrectionDto, EstimateEditDto, MissedChargeDto, PaymentDto, PaymentsQueryDto, PriceItemDto, ReasonDto, RefundPayDto, SnapshotQueryDto,
} from './revenue.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const run = <T>(metatype: new () => T, value: unknown, type: 'body' | 'query' = 'body') => pipe.transform(value, { type, metatype }) as Promise<T>;
const ID = '507f1f77bcf86cd799439011';

describe('Revenue DTOs', () => {
  test('DTOs refuse amount 0, a float amount, mode bitcoin, an empty reason and percent 101', async () => {
    const pay = { amount: 500, mode: 'cash', kind: 'part' };
    await run(PaymentDto, pay);
    await assert.rejects(() => run(PaymentDto, { ...pay, amount: 0 }), BadRequestException);
    await assert.rejects(() => run(PaymentDto, { ...pay, amount: 10.5 }), BadRequestException);
    await assert.rejects(() => run(PaymentDto, { ...pay, amount: 1_000_001 }), BadRequestException);
    await assert.rejects(() => run(PaymentDto, { ...pay, mode: 'bitcoin' }), BadRequestException);
    await assert.rejects(() => run(PaymentDto, { ...pay, mode: 'kiosk' }), BadRequestException);
    await assert.rejects(() => run(PaymentDto, { ...pay, kind: 'tip' }), BadRequestException);
    await run(PaymentDto, { ...pay, amount: 1_000_000 });
    for (const kind of ['deposit', 'part', 'settlement']) await run(PaymentDto, { ...pay, kind });

    await run(ReasonDto, { reason: 'x'.repeat(300) });
    await assert.rejects(() => run(ReasonDto, { reason: '' }), BadRequestException);
    await assert.rejects(() => run(ReasonDto, { reason: '   ' }), BadRequestException);
    await assert.rejects(() => run(ReasonDto, { reason: 'x'.repeat(301) }), BadRequestException);

    const disc = { kind: 'discount', percent: 100, reason: 'goodwill' };
    await run(CorrectionDto, disc);
    await assert.rejects(() => run(CorrectionDto, { ...disc, percent: 101 }), BadRequestException);
    await assert.rejects(() => run(CorrectionDto, { ...disc, percent: 0 }), BadRequestException);
    await assert.rejects(() => run(CorrectionDto, { ...disc, kind: 'gift' }), BadRequestException);
    await assert.rejects(() => run(CorrectionDto, { ...disc, reason: '' }), BadRequestException);
    await assert.rejects(() => run(CorrectionDto, { kind: 'writeoff', amount: 0, reason: 'x' }), BadRequestException);

    await assert.rejects(() => run(RefundPayDto, { mode: 'bitcoin' }), BadRequestException);
    await run(RefundPayDto, { mode: 'upi', reference: 'UTR1' });
  });

  test('codes match the price code pattern, prices and quantities are whole numbers, unknown fields are stripped', async () => {
    const item = { code: 'lab:cbc', name: 'CBC', category: 'lab', price: 300 };
    await run(PriceItemDto, item);
    for (const code of ['Lab:cbc', 'lab', 'lab:CBC', 'lab:c bc', '1:x']) await assert.rejects(() => run(PriceItemDto, { ...item, code }), BadRequestException, code);
    await assert.rejects(() => run(PriceItemDto, { ...item, category: 'food' }), BadRequestException);
    await assert.rejects(() => run(PriceItemDto, { ...item, price: 1.5 }), BadRequestException);
    await assert.rejects(() => run(PriceItemDto, { ...item, price: -1 }), BadRequestException);
    const stripped = await run(PriceItemDto, { ...item, evil: 'x' });
    assert.equal((stripped as unknown as Record<string, unknown>).evil, undefined);

    const charge = { category: 'other', qty: 1, reason: 'forgot', name: 'Gloves', unitPrice: 50 };
    await run(MissedChargeDto, charge);
    await run(MissedChargeDto, { ...charge, code: 'consumables:gloves' });
    await assert.rejects(() => run(MissedChargeDto, { ...charge, code: 'BAD' }), BadRequestException);
    await assert.rejects(() => run(MissedChargeDto, { ...charge, qty: 0 }), BadRequestException);
    await assert.rejects(() => run(MissedChargeDto, { ...charge, qty: 1.5 }), BadRequestException);
    await assert.rejects(() => run(MissedChargeDto, { ...charge, unitPrice: 2_000_000 }), BadRequestException);
  });

  test('estimate edits, queries and the range', async () => {
    await run(EstimateEditDto, { days: 7, extra: [{ name: 'Oxygen', amount: 500 }] });
    await assert.rejects(() => run(EstimateEditDto, { days: 0 }), BadRequestException);
    await assert.rejects(() => run(EstimateEditDto, { days: 61 }), BadRequestException);
    await assert.rejects(() => run(EstimateEditDto, { extra: [{ name: '', amount: 5 }] }), BadRequestException);
    await assert.rejects(() => run(EstimateEditDto, { extra: [{ name: 'x', amount: 1.5 }] }), BadRequestException);
    await assert.rejects(() => run(BillsQueryDto, { state: 'closed' }, 'query'), BadRequestException);
    await assert.rejects(() => run(BillsQueryDto, { kind: 'dental' }, 'query'), BadRequestException);
    await run(BillsQueryDto, { state: 'final', kind: 'walk-in', q: 'BL-1' }, 'query');
    await assert.rejects(() => run(PaymentsQueryDto, { day: '2026-02-31' }, 'query'), BadRequestException);
    await run(PaymentsQueryDto, { day: '2026-02-20' }, 'query');
    await assert.rejects(() => run(SnapshotQueryDto, { range: '30d' }, 'query'), BadRequestException);
    await run(SnapshotQueryDto, { range: '7d' }, 'query');
    assert.ok(ID);
  });
});
