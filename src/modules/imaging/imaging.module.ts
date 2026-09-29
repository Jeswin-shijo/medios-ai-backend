import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ImagingStudy, ImagingStudySchema } from './schemas/imaging.schema';
import { ImagingService } from './imaging.service';
import { ImagingController } from './imaging.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ImagingStudy.name, schema: ImagingStudySchema },
    ]),
  ],
  controllers: [ImagingController],
  providers: [ImagingService],
  exports: [ImagingService, MongooseModule],
})
export class ImagingModule {}
