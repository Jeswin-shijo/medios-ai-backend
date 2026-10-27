import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TaskAlertDocument, TaskAlertItem } from '../tasks-alerts/schemas/task-alert.schema';
import { BedRequestDocument } from './schemas/bed-request.schema';

/** The alert in Tasks & Alerts for a bed request nobody could place. */
@Injectable()
export class BedAlerts {
  constructor(@InjectModel(TaskAlertItem.name) private readonly alerts: Model<TaskAlertDocument>) {}

  /** Creates the request's alert, or updates it: one alert per request, keyed on its link. Returns its id. */
  async raise(req: BedRequestDocument): Promise<string> {
    const who = `${req.patientName} (${req.patientUhid})`;
    const link = `bed-request:${req._id}`;
    const fields = {
      title: req.state === 'waiting' ? `No bed for ${who}` : `Bed request needs attention: ${who}`,
      subtitle: req.stateReason,
      patientName: req.patientName,
      uhid: req.patientUhid,
      type: 'System',
      category: 'Critical',
      priority: 'High',
      status: 'Pending',
    };
    const upsert = () => this.alerts.findOneAndUpdate({ link }, { $set: fields, $setOnInsert: { link } }, { upsert: true, new: true }).exec();
    // Two upserts at once can both try to insert; the unique index stops one, which then updates.
    const alert = await upsert().catch((e: any) => {
      if (e?.code === 11000) return upsert();
      throw e;
    });
    return String(alert!._id);
  }

  /** Marks the request's alert done. Nothing happens when it has none. */
  async resolve(requestId: string): Promise<void> {
    await this.alerts.updateOne({ link: `bed-request:${requestId}` }, { status: 'Completed' }).exec();
  }
}
