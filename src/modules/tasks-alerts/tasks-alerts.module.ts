import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaskAlertItem, TaskAlertItemSchema } from './schemas/task-alert.schema';
import { TasksAlertsService } from './tasks-alerts.service';
import { TasksAlertsController } from './tasks-alerts.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TaskAlertItem.name, schema: TaskAlertItemSchema },
    ]),
  ],
  controllers: [TasksAlertsController],
  providers: [TasksAlertsService],
  exports: [TasksAlertsService, MongooseModule],
})
export class TasksAlertsModule {}
