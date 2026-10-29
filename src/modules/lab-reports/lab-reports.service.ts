import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LabTestReport, LabReportDocument } from './schemas/lab-report.schema';

export interface TrendSeries {
  parameter: string;
  unit: string;
  targetRange: string;
  history: { date: string; value: number; time?: string }[];
}

// Report dates are display strings ("26 Sep 2026", "Jan 2026"); unparseable ones sort last.
const dateValue = (date: string) => {
  const t = Date.parse(date);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
};

/** "09:30 AM" or "14:05" as minutes into the day; unparseable times sort last. */
const timeValue = (time?: string) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec((time ?? '').trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  let h = Number(m[1]) % 12 + (m[3]?.toUpperCase() === 'PM' ? 12 : 0);
  if (!m[3]) h = Number(m[1]);
  return h * 60 + Number(m[2]);
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

    // rid is internal: it tells apart two reports on the same day and is never returned.
    type Point = { date: string; value: number; time?: string; rid: string };
    const points = new Map<string, Point[]>();

    const add = (parameter: string, rid: string, date: string, value: number, unit = '', targetRange = '', time?: string, fromTrend = false) => {
      const entry = series.get(parameter) ?? { parameter, unit, targetRange, history: [] };
      entry.unit ||= unit;
      entry.targetRange ||= targetRange;
      const list = points.get(parameter) ?? [];
      const same = (h: Point) => {
        if (fromTrend) return h.date === date && (h.rid === rid || h.value === value);
        // Never by date alone: the same time, or (without a time) the same report, is the same point.
        return h.date === date && (time && h.time ? h.time === time : h.rid === rid);
      };
      if (!list.some(same)) {
        list.push({ date, value, rid, ...(time ? { time } : {}) });
        points.set(parameter, list);
      }
      series.set(parameter, entry);
    };

    for (const report of reports) {
      const rid = String(report._id);
      for (const group of report.groups) {
        for (const p of group.parameters) {
          const value = typeof p.result === 'number' ? p.result : parseFloat(p.result);
          if (Number.isFinite(value)) add(p.name, rid, report.date, value, p.unit, p.referenceRange, report.time || undefined);
        }
      }
      const trend = report.trend;
      if (trend?.parameter && Array.isArray(trend.history)) {
        for (const h of trend.history) {
          if (Number.isFinite(h?.value)) add(trend.parameter, rid, String(h.date), h.value, '', '', undefined, true);
        }
      }
    }
    for (const [parameter, list] of points) {
      series.get(parameter)!.history = list
        .sort((a, b) => dateValue(a.date) - dateValue(b.date) || timeValue(a.time) - timeValue(b.time))
        .map(({ date, value, time }) => ({ date, value, ...(time ? { time } : {}) }));
    }

    const trends = [...series.values()]
      .filter((s) => s.history.length >= 2);

    return { uhid, trends, totalReports: reports.length };
  }
}
