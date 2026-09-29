import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TaskAlertItem, TaskAlertDocument } from './schemas/task-alert.schema';

@Injectable()
export class TasksAlertsService {
  constructor(
    @InjectModel(TaskAlertItem.name)
    private taskModel: Model<TaskAlertDocument>,
  ) {}

  async findAll(query: {
    type?: string;
    priority?: string;
    status?: string;
    category?: string;
  }): Promise<TaskAlertItem[]> {
    const filter: any = {};
    if (query.type && query.type !== 'All') filter.type = query.type;
    if (query.priority && query.priority !== 'All') filter.priority = query.priority;
    if (query.status && query.status !== 'All') filter.status = query.status;
    if (query.category && query.category !== 'All') filter.category = query.category;

    return this.taskModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<TaskAlertDocument> {
    const task = await this.taskModel.findById(id).exec();
    if (!task) throw new NotFoundException(`Task ${id} not found`);
    return task;
  }

  async create(data: Partial<TaskAlertItem>): Promise<TaskAlertDocument> {
    const created = new this.taskModel(data);
    return created.save();
  }

  async toggleStatus(id: string): Promise<TaskAlertDocument> {
    const task = await this.findOne(id);
    task.status = task.status === 'Completed' ? 'Pending' : 'Completed';
    return task.save();
  }

  async updateStatus(id: string, status: string): Promise<TaskAlertDocument> {
    const task = await this.findOne(id);
    task.status = status;
    return task.save();
  }

  async getCriticalAlerts(): Promise<TaskAlertItem[]> {
    return this.taskModel
      .find({ priority: 'High', status: { $ne: 'Completed' } })
      .sort({ createdAt: -1 })
      .limit(10)
      .exec();
  }
}
