import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  BookAppointmentDto, ConsultRequestDto, FollowUpDto, MoveAppointmentDto, ProcedureRequestDto, RosterEntryDto, SlotsQueryDto,
} from './scheduling.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const run = <T>(metatype: new () => T, value: unknown) => pipe.transform(value, { type: 'body', metatype }) as Promise<T>;
const ID = '507f1f77bcf86cd799439011';

describe('Scheduling DTOs', () => {
  test('DTOs refuse a bad priority, a bad time, a 501-character consult reason and inDays 0', async () => {
    await assert.rejects(() => run(ProcedureRequestDto, { patientId: ID, procedure: 'ct-head', priority: 'asap' }), BadRequestException);
    await run(ProcedureRequestDto, { patientId: ID, procedure: 'ct-head', priority: 'stat' });

    const apt = { patientId: ID, doctorId: ID, date: '2026-10-05', time: '09:30 AM' };
    await run(BookAppointmentDto, apt);
    for (const time of ['9:30 AM', '09:30', '13:30', '09:30 am', '09:75 AM']) {
      await assert.rejects(() => run(BookAppointmentDto, { ...apt, time }), BadRequestException, time);
      await assert.rejects(() => run(MoveAppointmentDto, { date: '2026-10-05', time }), BadRequestException, time);
    }
    for (const date of ['05-10-2026', '2026-10-5', '2026/10/05']) await assert.rejects(() => run(BookAppointmentDto, { ...apt, date }), BadRequestException, date);

    const consult = { patientId: ID, departmentCode: 'CARD', priority: 'urgent', reason: 'x'.repeat(500) };
    await run(ConsultRequestDto, consult);
    await assert.rejects(() => run(ConsultRequestDto, { ...consult, reason: 'x'.repeat(501) }), BadRequestException);
    await assert.rejects(() => run(ConsultRequestDto, { ...consult, reason: '' }), BadRequestException);

    for (const inDays of [0, 366, 1.5, '7']) await assert.rejects(() => run(FollowUpDto, { patientId: ID, inDays }), BadRequestException, String(inDays));
    for (const inDays of [1, 365]) await run(FollowUpDto, { patientId: ID, inDays });
  });

  test('a roster entry needs a known shift and a date; slots count is 1 to 50', async () => {
    await run(RosterEntryDto, { date: '2026-10-05', shift: 'morning', staffId: ID, titles: ['duty-doctor'] });
    await assert.rejects(() => run(RosterEntryDto, { date: '2026-10-05', shift: 'lunch', staffId: ID }), BadRequestException);
    await assert.rejects(() => pipe.transform({ count: '0' }, { type: 'query', metatype: SlotsQueryDto }), BadRequestException);
    const q = (await pipe.transform({ from: '2026-10-05', count: '5' }, { type: 'query', metatype: SlotsQueryDto })) as SlotsQueryDto;
    assert.equal(q.count, 5);
  });
});
