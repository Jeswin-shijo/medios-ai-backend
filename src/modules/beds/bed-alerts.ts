import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { BedRequestDocument } from './schemas/bed-request.schema';

/** The alert in Tasks & Alerts for a bed request nobody could place. */
@Injectable()
export class BedAlerts {
  constructor(@InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>) {}

  /** Creates the request's alert, or updates it when it has one. Returns its id. */
  async raise(req: BedRequestDocument): Promise<string> {
    const who = `${req.patientName} (${req.patientUhid})`;
    const fields = {
      title: req.state === 'waiting' ? `No bed for ${who}` : `Bed request needs attention: ${who}`,
      subtitle: req.stateReason,
      patientName: req.patientName,
      uhid: req.patientUhid,
      type: 'System',
      category: 'Critical',
      priority: 'High',
      status: 'Pending',
      link: `bed-request:${req._id}`,
    };
    if (req.alert) {
      const updated = await this.alerts.findByIdAndUpdate(req.alert, fields, { new: true }).exec();
      if (updated) return String(updated._id);
    }
    return String((await this.alerts.create(fields))._id);
  }

  async resolve(alertId?: string): Promise<void> {
    if (!alertId) return;
    await this.alerts.updateOne({ _id: alertId }, { status: 'Completed' }).exec();
  }
}
