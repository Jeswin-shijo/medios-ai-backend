import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LabTestReport, LabTestReportSchema } from './schemas/lab-report.schema';
import { LabReportsService } from './lab-reports.service';
import { LabReportsController } from './lab-reports.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LabTestReport.name, schema: LabTestReportSchema },
    ]),
  ],
  controllers: [LabReportsController],
  providers: [LabReportsService],
  exports: [LabReportsService, MongooseModule],
})
export class LabReportsModule {}
