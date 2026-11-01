import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  BookAppointmentDto, ConsultRequestDto, FollowUpDto, LeaveRangeDto, MoveAppointmentDto, OverviewQueryDto, ProcedureRequestDto, RoomBlockDto,
  RosterEntryDto, SchedulingSlotsQueryDto,
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
    await assert.rejects(() => pipe.transform({ count: '0' }, { type: 'query', metatype: SchedulingSlotsQueryDto }), BadRequestException);
    const q = (await pipe.transform({ from: '2026-10-05', count: '5' }, { type: 'query', metatype: SchedulingSlotsQueryDto })) as SchedulingSlotsQueryDto;
    assert.equal(q.count, 5);
  });
});

describe('Scheduling DTOs: real dates, room blocks, whitelist', () => {
  const apt = { patientId: ID, doctorId: ID, date: '2026-10-05', time: '09:30 AM' };

  test('a date that is not real is refused: 2026-13-45, 2026-02-31, 2026-04-31; a leap day passes', async () => {
    for (const date of ['2026-13-45', '2026-02-31', '2026-04-31', '2026-00-10', '2026-10-00']) {
      await assert.rejects(() => run(BookAppointmentDto, { ...apt, date }), BadRequestException, date);
      await assert.rejects(() => run(MoveAppointmentDto, { date, time: '09:30 AM' }), BadRequestException, date);
      await assert.rejects(() => pipe.transform({ day: date }, { type: 'query', metatype: OverviewQueryDto }), BadRequestException, date);
      await assert.rejects(() => run(LeaveRangeDto, { from: date, to: '2026-12-01' }), BadRequestException, date);
    }
    await run(BookAppointmentDto, { ...apt, date: '2028-02-29' });
    await assert.rejects(() => run(BookAppointmentDto, { ...apt, date: '2027-02-29' }), BadRequestException);
  });

  test('a moment that is not real is refused in the room-block and slots DTOs', async () => {
    await run(RoomBlockDto, { from: '2026-10-05T08:00', to: '2026-10-05T10:00', reason: 'Deep clean' });
    for (const bad of ['2026-02-31T10:00', '2026-10-05T25:00', '2026-10-05', '2026-10-05T10:00Z']) {
      await assert.rejects(() => run(RoomBlockDto, { from: bad, to: '2026-10-06T10:00' }), BadRequestException, bad);
    }
    await assert.rejects(() => run(RoomBlockDto, { from: '2026-10-05T08:00', to: '2026-10-05T10:00', reason: 'x'.repeat(301) }), BadRequestException);
    await assert.rejects(() => pipe.transform({ from: '2026-02-31T10:00' }, { type: 'query', metatype: SchedulingSlotsQueryDto }), BadRequestException);
    await assert.rejects(() => run(ProcedureRequestDto, { patientId: ID, procedure: 'ct-head', priority: 'stat', earliest: '2026-02-31' }), BadRequestException);
  });

  test('whitelist stripping drops an unknown field', async () => {
    const out = (await run(BookAppointmentDto, { ...apt, bookedVia: 'call', leadMinutes: 0 })) as unknown as Record<string, unknown>;
    assert.equal('bookedVia' in out, false);
    assert.equal('leadMinutes' in out, false);
    assert.equal(out.date, '2026-10-05');
  });
});
