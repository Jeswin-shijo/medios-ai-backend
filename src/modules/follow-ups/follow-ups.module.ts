import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FollowUpItem, FollowUpItemSchema } from './schemas/follow-up.schema';
import { FollowUpsService } from './follow-ups.service';
import { FollowUpsController } from './follow-ups.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FollowUpItem.name, schema: FollowUpItemSchema },
    ]),
  ],
  controllers: [FollowUpsController],
  providers: [FollowUpsService],
  exports: [FollowUpsService, MongooseModule],
})
export class FollowUpsModule {}
