import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { Patient, PatientSchema } from '../patients/schemas/patient.schema';
import { Appointment, AppointmentSchema } from '../appointments/schemas/appointment.schema';
import { LabTestReport, LabTestReportSchema } from '../lab-reports/schemas/lab-report.schema';
import { ImagingStudy, ImagingStudySchema } from '../imaging/schemas/imaging.schema';
import { BillInvoice, BillInvoiceSchema } from '../billing/schemas/bill.schema';
import { Consultation, ConsultationSchema } from '../consultations/schemas/consultation.schema';
import { TaskAlertItem, TaskAlertItemSchema } from '../tasks-alerts/schemas/task-alert.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Patient.name, schema: PatientSchema },
      { name: Appointment.name, schema: AppointmentSchema },
      { name: LabTestReport.name, schema: LabTestReportSchema },
      { name: ImagingStudy.name, schema: ImagingStudySchema },
      { name: BillInvoice.name, schema: BillInvoiceSchema },
      { name: Consultation.name, schema: ConsultationSchema },
      { name: TaskAlertItem.name, schema: TaskAlertItemSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
