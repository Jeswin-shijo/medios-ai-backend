import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TimelineEvent, TimelineEventDocument } from './schemas/timeline.schema';

@Injectable()
export class TimelineService {
  constructor(
    @InjectModel(TimelineEvent.name)
    private timelineModel: Model<TimelineEventDocument>,
  ) {}

  async findByPatient(uhid: string, category?: string): Promise<TimelineEvent[]> {
    const filter: any = { uhid };
    if (category && category !== 'All') {
      filter.category = category;
    }
    return this.timelineModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async create(data: Partial<TimelineEvent>): Promise<TimelineEventDocument> {
    const created = new this.timelineModel(data);
    return created.save();
  }
}
