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

    // followUpDate is a display string ("26 Sep 2026"), so order by the parsed date, not the text.
    const items = await this.followUpModel.find(filter).exec();
    const when = (d: string) => Date.parse(d) || Number.MAX_SAFE_INTEGER;
    return items.sort((a, b) => when(a.followUpDate) - when(b.followUpDate));
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

  /**
   * No SMS/WhatsApp provider is integrated yet, so nothing is sent. The response
   * says so plainly instead of reporting a delivery that never happened.
   */
  async sendReminder(id: string) {
    const item = await this.findOne(id);
    return {
      sent: false,
      message: `No SMS/WhatsApp provider is configured, so no reminder was sent to ${item.patientName}.`,
      recipient: item.patientName,
      scheduledDate: item.followUpDate,
    };
  }
}
