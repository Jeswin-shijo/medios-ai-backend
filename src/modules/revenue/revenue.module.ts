import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Ward, WardSchema } from '../beds/schemas/ward.schema';
import { OpDoctor, OpDoctorSchema } from '../opd/schemas/op-doctor.schema';
import { SettingsModule } from '../settings/settings.module';
import { PriceListService } from './price-list.service';
import { RevenueSettingsService } from './revenue-settings.service';
import { PriceItem, PriceItemSchema } from './schemas/price-item.schema';

/**
 * The Revenue agent. It reads other agents' records read-only through their models and never imports their services.
 * Later tasks add the bills, the controller and the scheduler here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PriceItem.name, schema: PriceItemSchema },
      { name: Ward.name, schema: WardSchema },
      { name: OpDoctor.name, schema: OpDoctorSchema },
    ]),
    SettingsModule,
  ],
  providers: [PriceListService, RevenueSettingsService],
  exports: [PriceListService, RevenueSettingsService],
})
export class RevenueModule {}
