import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BillInvoice, BillInvoiceSchema } from './schemas/bill.schema';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BillInvoice.name, schema: BillInvoiceSchema },
    ]),
  ],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService, MongooseModule],
})
export class BillingModule {}
