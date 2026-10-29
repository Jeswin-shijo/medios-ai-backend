import * as assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeTestDb, connectTestDb, models, resetTestDb } from '../../test/test-db';
import { LabReportsService } from './lab-reports.service';

describe('LabReportsService.getTrends', () => {
  const m = models();
  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
  });

  const report = (date: string, time: string, value: number) =>
    m.LabTestReport.create({
      uhid: 'MHK202600901',
      testName: 'Troponin I',
      category: 'Biochemistry',
      date,
      time,
      status: 'Completed',
      groups: [{ category: 'Troponin I', parameters: [{ name: 'Troponin I', result: value, referenceRange: '≤ 0.04', unit: 'ng/mL', status: 'High', critical: false }] }],
    });

  test('trends keep two troponin results from the same day in time order', async () => {
    await report('26 Sep 2026', '02:30 PM', 0.9);
    await report('26 Sep 2026', '09:10 AM', 0.3);
    await report('25 Sep 2026', '08:00 AM', 0.1);
    const { trends } = await new LabReportsService(m.LabTestReport).getTrends('MHK202600901');
    assert.equal(trends.length, 1);
    assert.deepEqual(trends[0].history.map((h) => h.value), [0.1, 0.3, 0.9]);
  });

  test('the same report seen twice is still one point', async () => {
    const r = await report('26 Sep 2026', '09:10 AM', 0.3);
    await m.LabTestReport.updateOne({ _id: r._id }, { $set: { trend: { parameter: 'Troponin I', history: [{ date: '26 Sep 2026', value: 0.3 }, { date: '25 Sep 2026', value: 0.1 }] } } });
    const { trends } = await new LabReportsService(m.LabTestReport).getTrends('MHK202600901');
    assert.equal(trends[0].history.length, 2);
  });
});
