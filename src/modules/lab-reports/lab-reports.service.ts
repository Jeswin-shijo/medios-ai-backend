import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LabTestReport, LabReportDocument } from './schemas/lab-report.schema';

interface TrendSeries {
  parameter: string;
  unit: string;
  targetRange: string;
  history: { date: string; value: number }[];
}

// Report dates are display strings ("26 Sep 2026", "Jan 2026"); unparseable ones sort last.
const dateValue = (date: string) => {
  const t = Date.parse(date);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
};

@Injectable()
export class LabReportsService {
  constructor(
    @InjectModel(LabTestReport.name)
    private labReportModel: Model<LabReportDocument>,
  ) {}

  async findAll(query: { uhid?: string; category?: string; status?: string }): Promise<LabTestReport[]> {
    const filter: any = {};
    if (query.uhid) filter.uhid = query.uhid;
    if (query.category && query.category !== 'All') filter.category = query.category;
    if (query.status && query.status !== 'All') filter.status = query.status;

    return this.labReportModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<LabReportDocument> {
    const report = await this.labReportModel.findById(id).exec();
    if (!report) throw new NotFoundException(`Lab Report ${id} not found`);
    return report;
  }

  async create(data: Partial<LabTestReport>): Promise<LabReportDocument> {
    const created = new this.labReportModel(data);
    return created.save();
  }

  /**
   * Per-parameter series built from this patient's reports: every numeric result,
   * plus the earlier readings a report carries in its `trend` history. Only
   * parameters measured at least twice are returned.
   */
  async getTrends(uhid: string) {
    const reports = await this.labReportModel.find({ uhid }).exec();
    const series = new Map<string, TrendSeries>();

    const add = (parameter: string, date: string, value: number, unit = '', targetRange = '') => {
      const entry = series.get(parameter) ?? { parameter, unit, targetRange, history: [] };
      entry.unit ||= unit;
      entry.targetRange ||= targetRange;
      if (!entry.history.some((h) => h.date === date)) entry.history.push({ date, value });
      series.set(parameter, entry);
    };

    for (const report of reports) {
      for (const group of report.groups) {
        for (const p of group.parameters) {
          const value = typeof p.result === 'number' ? p.result : parseFloat(p.result);
          if (Number.isFinite(value)) add(p.name, report.date, value, p.unit, p.referenceRange);
        }
      }
      const trend = report.trend;
      if (trend?.parameter && Array.isArray(trend.history)) {
        for (const h of trend.history) {
          if (Number.isFinite(h?.value)) add(trend.parameter, String(h.date), h.value);
        }
      }
    }

    const trends = [...series.values()]
      .filter((s) => s.history.length >= 2)
      .map((s) => ({ ...s, history: s.history.sort((a, b) => dateValue(a.date) - dateValue(b.date)) }));

    return { uhid, trends, totalReports: reports.length };
  }
}
