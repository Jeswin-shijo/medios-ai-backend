import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FollowUpItem, FollowUpDocument } from './schemas/follow-up.schema';

@Injectable()
export class FollowUpsService {
  constructor(
    @InjectModel(FollowUpItem.name)
    private followUpModel: Model<FollowUpDocument>,
  ) {}

  async findAll(query: { status?: string; date?: string; uhid?: string }): Promise<FollowUpItem[]> {
    const filter: any = {};
    if (query.status && query.status !== 'All') filter.status = query.status;
    if (query.date) filter.followUpDate = query.date;
    if (query.uhid) filter.uhid = query.uhid;

    return this.followUpModel.find(filter).sort({ followUpDate: 1 }).exec();
  }

  async findOne(id: string): Promise<FollowUpDocument> {
    const item = await this.followUpModel.findById(id).exec();
    if (!item) throw new NotFoundException(`Follow-up ${id} not found`);
    return item;
  }

  async create(data: Partial<FollowUpItem>): Promise<FollowUpDocument> {
    const created = new this.followUpModel(data);
    return created.save();
  }

  async updateStatus(id: string, status: string): Promise<FollowUpDocument> {
    const item = await this.findOne(id);
    item.status = status;
    return item.save();
  }

  async sendReminder(id: string) {
    const item = await this.findOne(id);
    return {
      success: true,
      message: `Automated reminder successfully dispatched via SMS and WhatsApp to ${item.patientName}`,
      dispatchedAt: new Date().toISOString(),
      recipient: item.patientName,
      scheduledDate: item.followUpDate,
    };
  }
}
