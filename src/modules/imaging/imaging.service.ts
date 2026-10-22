import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ImagingStudy, ImagingStudyDocument } from './schemas/imaging.schema';
import { displayDateTime } from '../../common/utils/clinic-time';

@Injectable()
export class ImagingService {
  constructor(
    @InjectModel(ImagingStudy.name)
    private imagingModel: Model<ImagingStudyDocument>,
  ) {}

  async findAll(query: { uhid?: string; modality?: string }): Promise<ImagingStudy[]> {
    const filter: any = {};
    if (query.uhid) filter.uhid = query.uhid;
    if (query.modality && query.modality !== 'all' && query.modality !== 'All Images') {
      filter.modality = query.modality;
    }

    return this.imagingModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<ImagingStudyDocument> {
    const study = await this.imagingModel.findById(id).exec();
    if (!study) throw new NotFoundException(`Imaging study ${id} not found`);
    return study;
  }

  async create(data: Partial<ImagingStudy>): Promise<ImagingStudyDocument> {
    const created = new this.imagingModel(data);
    return created.save();
  }

  async updateReport(id: string, reportData: any): Promise<ImagingStudyDocument> {
    const study = await this.findOne(id);
    study.radiologistReport = {
      ...(study.toObject().radiologistReport ?? {}),
      ...reportData,
      reportedOn: displayDateTime(),
      status: 'Final Report',
    };
    study.status = 'Reported';
    return study.save();
  }
}
