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

  async getDashboardStats() {
    const [
      totalPatients,
      appointments,
      totalLabs,
      totalImaging,
      bills,
      totalConsultations,
      criticalAlerts,
    ] = await Promise.all([
      this.patientModel.countDocuments().exec(),
      this.appointmentModel.find({}).sort({ time: 1 }).limit(10).exec(),
      this.labModel.countDocuments().exec(),
      this.imagingModel.countDocuments().exec(),
      this.billModel.find({}).exec(),
      this.consultationModel.countDocuments().exec(),
      this.taskModel.find({ priority: 'High' }).limit(5).exec(),
    ]);

    const todayAppointmentsCount = appointments.length || 18;
    const completedApts = appointments.filter(a => a.status === 'Completed').length;
    const pendingApts = todayAppointmentsCount - completedApts;

    const todayRevenue = bills.reduce((acc, b) => acc + (b.paidAmount || 0), 0) || 24850;

    return {
      kpis: [
        {
          label: "Today's Appointments",
          value: todayAppointmentsCount.toString(),
          sub: `${completedApts || 12} Completed • ${pendingApts || 6} Pending`,
          color: 'blue',
        },
        {
          label: 'Total Patients',
          value: totalPatients.toString() || '124',
          sub: '+12 new today',
          color: 'green',
        },
        {
          label: 'Consultations',
          value: totalConsultations.toString() || '16',
          sub: '4 AI Notes Generated',
          color: 'red',
        },
        {
          label: 'Lab Reports',
          value: totalLabs.toString() || '28',
          sub: '5 Pending',
          color: 'sky',
        },
        {
          label: 'Imaging Reports',
          value: totalImaging.toString() || '12',
          sub: '3 Pending',
          color: 'orange',
        },
        {
          label: 'Billing (Today)',
          value: `₹ ${todayRevenue.toLocaleString()}`,
          sub: `${bills.length || 21} Invoices`,
          color: 'purple',
        },
      ],
      todaySchedule: appointments.map(a => ({
        id: a._id,
        uhid: a.uhid,
        time: a.time,
        name: a.patientName,
        reason: `${a.type} • ${a.condition}`,
        status: a.status,
      })),
      patientFlow: [
        { label: 'Completed', value: 82, pct: 66, color: 'var(--chart-green)' },
        { label: 'In Consultation', value: 16, pct: 13, color: 'var(--chart-blue)' },
        { label: 'Waiting', value: 12, pct: 10, color: 'var(--chart-orange)' },
        { label: 'Scheduled', value: 14, pct: 11, color: 'var(--chart-gray)' },
      ],
      consultationTypes: [
        { label: 'General', count: 8, color: 'var(--chart-blue)' },
        { label: 'Follow-up', count: 5, color: 'var(--chart-sky)' },
        { label: 'Diabetes', count: 4, color: 'var(--chart-green)' },
        { label: 'Hypertension', count: 3, color: 'var(--chart-orange)' },
        { label: 'Others', count: 2, color: 'var(--chart-purple)' },
      ],
      criticalAlerts: criticalAlerts.map(c => ({
        id: c._id,
        title: c.title,
        sub: c.subtitle,
        due: c.dueDateTime,
        priority: c.priority,
      })),
    };
  }
}
