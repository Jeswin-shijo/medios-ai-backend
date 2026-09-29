import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VitalsRecord, VitalsRecordSchema } from './schemas/vitals.schema';
import { VitalsService } from './vitals.service';
import { VitalsController } from './vitals.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: VitalsRecord.name, schema: VitalsRecordSchema },
    ]),
  ],
  controllers: [VitalsController],
  providers: [VitalsService],
  exports: [VitalsService, MongooseModule],
})
export class VitalsModule {}
