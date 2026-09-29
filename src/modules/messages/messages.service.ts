import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MessageThread, MessageThreadDocument } from './schemas/message.schema';

@Injectable()
export class MessagesService {
  constructor(
    @InjectModel(MessageThread.name)
    private threadModel: Model<MessageThreadDocument>,
  ) {}

  async findAll(category?: string): Promise<MessageThread[]> {
    const filter: any = {};
    if (category && category !== 'All' && category !== 'all') {
      filter.category = category;
    }
    return this.threadModel.find(filter).sort({ updatedAt: -1 }).exec();
  }

  async findOne(id: string): Promise<MessageThreadDocument> {
    const thread = await this.threadModel.findById(id).exec();
    if (!thread) throw new NotFoundException(`Thread ${id} not found`);
    return thread;
  }

  async sendMessage(
    id: string,
    sender: string,
    text: string,
    attachment?: any,
  ): Promise<MessageThreadDocument> {
    const thread = await this.findOne(id);
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    thread.messages.push({
      sender,
      text,
      time: timeStr,
      status: 'delivered',
      attachment: attachment || null,
    } as any);

    thread.preview = text;
    thread.time = timeStr;
    return thread.save();
  }

  async markAsRead(id: string): Promise<MessageThreadDocument> {
    const thread = await this.findOne(id);
    thread.unreadCount = 0;
    return thread.save();
  }

  async getUnreadCount(): Promise<number> {
    const threads = await this.threadModel.find({ unreadCount: { $gt: 0 } }).exec();
    return threads.reduce((acc, t) => acc + (t.unreadCount || 0), 0);
  }

  async create(data: Partial<MessageThread>): Promise<MessageThreadDocument> {
    const created = new this.threadModel(data);
    return created.save();
  }
}
