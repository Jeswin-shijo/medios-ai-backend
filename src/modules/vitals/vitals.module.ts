import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VitalsRecord, VitalsRecordSchema } from './schemas/vitals.schema';
import { Patient, PatientSchema } from '../patients/schemas/patient.schema';
import { VitalsService } from './vitals.service';
import { VitalsController } from './vitals.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VitalsRecord.name, schema: VitalsRecordSchema },
      { name: Patient.name, schema: PatientSchema },
    ]),
  ],
  controllers: [VitalsController],
  providers: [VitalsService],
  exports: [VitalsService, MongooseModule],
})
export class VitalsModule {}
