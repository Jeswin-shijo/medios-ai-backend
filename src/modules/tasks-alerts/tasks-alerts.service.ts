import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  /** A task or alert from staff. `escalation` and `link` are set only by the server, so they are dropped here. */
  async create(data: Partial<TaskAlertItem>): Promise<TaskAlertDocument> {
    const { escalation: _escalation, link: _link, ...rest } = (data ?? {}) as Partial<TaskAlertItem>;
    const created = new this.taskModel(rest);
    return created.save();
  }

  private refuseEscalation(task: TaskAlertDocument): void {
    // A critical lab result has one acknowledgement path, the result itself: nobody, admin included, ticks it off here.
    if (task.link?.startsWith('lab-line:')) throw new ConflictException('Acknowledge this critical result on the Lab page.');
    // A pharmacy query has one answer path, the query itself.
    if (task.link?.startsWith('pharmacy-line:')) throw new ConflictException('Answer this query on the Pharmacy Agent page.');
    // A consult has one path, the consult itself.
    if (task.link?.startsWith('scheduling-consult:')) throw new ConflictException('Accept or complete this consult on the Scheduling page.');
    if (task.escalation) throw new ConflictException('Use Acknowledge for escalation alerts.');
  }

  async toggleStatus(id: string): Promise<TaskAlertDocument> {
    const task = await this.findOne(id);
    this.refuseEscalation(task);
    task.status = task.status === 'Completed' ? 'Pending' : 'Completed';
    return task.save();
  }

  async updateStatus(id: string, status: string): Promise<TaskAlertDocument> {
    const task = await this.findOne(id);
    this.refuseEscalation(task);
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
