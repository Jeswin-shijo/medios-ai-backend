import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { LabTestReport, LabReportDocument } from './schemas/lab-report.schema';

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

  async getTrends(uhid: string) {
    const reports = await this.labReportModel.find({ uhid }).exec();
    return {
      uhid,
      trends: [
        {
          parameter: 'HbA1c',
          unit: '%',
          targetRange: '< 6.5',
          history: [
            { date: '10 Jan 2026', value: 8.2 },
            { date: '15 Apr 2026', value: 7.6 },
            { date: '20 Jul 2026', value: 7.1 },
            { date: '26 Sep 2026', value: 6.8 },
          ],
        },
        {
          parameter: 'Hemoglobin',
          unit: 'g/dL',
          targetRange: '13.5 - 17.5',
          history: [
            { date: '10 Jan 2026', value: 14.1 },
            { date: '15 Apr 2026', value: 14.3 },
            { date: '20 Jul 2026', value: 14.2 },
            { date: '26 Sep 2026', value: 14.5 },
          ],
        },
        {
          parameter: 'Fasting Blood Sugar',
          unit: 'mg/dL',
          targetRange: '70 - 100',
          history: [
            { date: '10 Jan 2026', value: 164 },
            { date: '15 Apr 2026', value: 142 },
            { date: '20 Jul 2026', value: 128 },
            { date: '26 Sep 2026', value: 118 },
          ],
        },
      ],
      totalReports: reports.length,
    };
  }
}
