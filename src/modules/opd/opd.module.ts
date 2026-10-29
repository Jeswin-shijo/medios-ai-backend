import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Department, DepartmentSchema } from './schemas/department.schema';
import { OpDoctor, OpDoctorSchema } from './schemas/op-doctor.schema';
import { OpdController } from './opd.controller';
import { OpdService } from './opd.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Department.name, schema: DepartmentSchema },
      { name: OpDoctor.name, schema: OpDoctorSchema },
    ]),
    SettingsModule,
  ],
  controllers: [OpdController],
  providers: [OpdService],
  exports: [OpdService, MongooseModule],
})
export class OpdModule {}
