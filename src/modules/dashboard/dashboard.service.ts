import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Patient, PatientDocument } from '../patients/schemas/patient.schema';
import { Appointment, AppointmentDocument } from '../appointments/schemas/appointment.schema';
import { LabTestReport, LabReportDocument } from '../lab-reports/schemas/lab-report.schema';
import { ImagingStudy, ImagingStudyDocument } from '../imaging/schemas/imaging.schema';
import { BillInvoice, BillInvoiceDocument } from '../billing/schemas/bill.schema';
import { Consultation, ConsultationDocument } from '../consultations/schemas/consultation.schema';
import { TaskAlertItem, TaskAlertDocument } from '../tasks-alerts/schemas/task-alert.schema';
import { clockMinutes, displayDate, isoDate } from '../../common/utils/clinic-time';

const countBy = (values: string[]) =>
  [...values.reduce((acc, v) => acc.set(v, (acc.get(v) ?? 0) + 1), new Map<string, number>())].map(
    ([label, count]) => ({ label, count }),
  );

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Patient.name) private patientModel: Model<PatientDocument>,
    @InjectModel(Appointment.name) private appointmentModel: Model<AppointmentDocument>,
    @InjectModel(LabTestReport.name) private labModel: Model<LabReportDocument>,
    @InjectModel(ImagingStudy.name) private imagingModel: Model<ImagingStudyDocument>,
    @InjectModel(BillInvoice.name) private billModel: Model<BillInvoiceDocument>,
    @InjectModel(Consultation.name) private consultationModel: Model<ConsultationDocument>,
    @InjectModel(TaskAlertItem.name) private taskModel: Model<TaskAlertDocument>,
  ) {}

  /**
   * Everything the dashboard shows for one day, computed from the records. Numbers
   * only; labels, colours and formatting belong to the client.
   */
  async getDashboardStats(day: Date) {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const displayDay = displayDate(day);

    const [
      totalPatients,
      newPatients,
      appointments,
      consultations,
      totalLabs,
      pendingLabs,
      totalImaging,
      pendingImaging,
      bills,
      criticalAlerts,
      recentPatients,
    ] = await Promise.all([
      this.patientModel.countDocuments().exec(),
      this.patientModel.countDocuments({ createdAt: { $gte: dayStart, $lt: dayEnd } }).exec(),
      this.appointmentModel.find({ date: isoDate(day) }).exec(),
      this.consultationModel.find({ visitDate: displayDay }).exec(),
      this.labModel.countDocuments().exec(),
      this.labModel.countDocuments({ status: 'Pending' }).exec(),
      this.imagingModel.countDocuments().exec(),
      this.imagingModel.countDocuments({ status: 'Pending' }).exec(),
      this.billModel.find({ billDate: displayDay }).exec(),
      this.taskModel
        .find({ priority: 'High', status: { $ne: 'Completed' } })
        .sort({ createdAt: -1 })
        .limit(6)
        .exec(),
      this.patientModel.find().sort({ updatedAt: -1 }).limit(6).exec(),
    ]);

    const active = appointments.filter((a) => a.status !== 'Canceled');
    const completed = active.filter((a) => a.status === 'Completed').length;
    const schedule = [...appointments].sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));

    return {
      date: isoDate(day),
      appointments: { total: active.length, completed, pending: active.length - completed },
      patients: { total: totalPatients, newToday: newPatients },
      consultations: {
        total: consultations.length,
        finalised: consultations.filter((c) => c.isFinal).length,
      },
      labReports: { total: totalLabs, pending: pendingLabs },
      imaging: { total: totalImaging, pending: pendingImaging },
      billing: {
        revenue: bills.reduce((acc, b) => acc + (b.paidAmount || 0), 0),
        invoices: bills.length,
      },
      schedule: schedule.map((a) => ({
        id: String(a._id),
        uhid: a.uhid,
        time: a.time,
        patientName: a.patientName,
        type: a.type,
        condition: a.condition,
        status: a.status,
      })),
      patientFlow: countBy(active.map((a) => a.status)),
      consultationTypes: countBy(active.map((a) => a.type)),
      criticalAlerts: criticalAlerts.map((t) => ({
        id: String(t._id),
        title: t.title,
        subtitle: t.subtitle,
        patientName: t.patientName,
        uhid: t.uhid,
        type: t.type,
        category: t.category,
        dueDateTime: t.dueDateTime,
      })),
      recentPatients: recentPatients.map((p) => ({
        id: String(p._id),
        uhid: p.uhid,
        name: p.name,
        age: p.age,
        gender: p.gender,
        avatar: p.avatar,
        reason: p.conditions[0] ?? '',
        lastVisit: p.lastVisit,
      })),
    };
  }
}
