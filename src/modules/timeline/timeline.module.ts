import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TimelineEvent, TimelineEventSchema } from './schemas/timeline.schema';
import { TimelineService } from './timeline.service';
import { TimelineController } from './timeline.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TimelineEvent.name, schema: TimelineEventSchema },
    ]),
  ],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService, MongooseModule],
})
export class TimelineModule {}
