import { Types, Model } from 'mongoose';
import { clinicNow, displayDate, displayTime } from '../../common/utils/clinic-time';
import { LabReportDocument } from '../lab-reports/schemas/lab-report.schema';
import { templateSummary } from './lab-ai';
import { LabTestDef, rangeText } from './lab-catalogue';
import { LabLineDocument } from './schemas/lab-line.schema';
import { LabRequestDocument } from './schemas/lab-request.schema';

const STATUS_LABEL = { normal: 'Normal', low: 'Low', high: 'High', abnormal: 'Abnormal' } as const;

/**
 * One LabTestReport per line: a later release or amendment updates it. A plain function over the two
 * models so both the results service and the reconcile pass can use it without a circular dependency.
 */
export async function writeLabReport(
  reports: Model<LabReportDocument>,
  lines: Model<LabLineDocument>,
  line: LabLineDocument,
  request: LabRequestDocument,
  def: LabTestDef,
  version: number,
): Promise<Types.ObjectId> {
  const now = clinicNow();
  const parameters = line.results.map((r) => ({
    name: r.param,
    result: r.value,
    referenceRange: rangeText(def.key, def.params.find((p) => p.name === r.param)!),
    unit: r.unit,
    status: STATUS_LABEL[r.flag],
    critical: r.critical,
  }));
  const fields = {
    uhid: request.patientUhid,
    testName: def.label,
    category: def.category,
    date: displayDate(now),
    time: displayTime(now),
    status: line.results.some((r) => r.flag !== 'normal') ? 'Abnormal' : 'Completed',
    groups: [{ category: def.label, parameters }],
    labLine: String(line._id),
    amended: version > 1,
    aiSummary: {
      sample: false,
      ...templateSummary(
        line.results.map((r, i) => ({ name: r.param, value: r.value, unit: r.unit, referenceRange: parameters[i].referenceRange, flag: r.flag, critical: r.critical })),
      ),
    },
  };
  let report = line.reportId ? await reports.findByIdAndUpdate(line.reportId, { $set: fields }, { new: true }).exec() : null;
  if (!report) {
    report = await reports.create(fields);
    await lines.updateOne({ _id: line._id }, { $set: { reportId: report._id } }).exec();
  }
  return report._id as Types.ObjectId;
}
