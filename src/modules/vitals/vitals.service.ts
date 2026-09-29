import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VitalsRecord, VitalsRecordDocument } from './schemas/vitals.schema';

@Injectable()
export class VitalsService {
  constructor(
    @InjectModel(VitalsRecord.name)
    private vitalsModel: Model<VitalsRecordDocument>,
  ) {}

  async findByPatient(uhid: string, range?: string): Promise<VitalsRecord[]> {
    let limit = 50;
    if (range === '1M') limit = 10;
    else if (range === '3M') limit = 20;
    else if (range === '6M') limit = 30;

    return this.vitalsModel.find({ uhid }).sort({ createdAt: -1 }).limit(limit).exec();
  }

  async getLatest(uhid: string): Promise<VitalsRecordDocument> {
    const latest = await this.vitalsModel.findOne({ uhid }).sort({ createdAt: -1 }).exec();
    if (!latest) {
      throw new NotFoundException(`No vitals found for patient ${uhid}`);
    }
    return latest;
  }

  async create(data: Partial<VitalsRecord>): Promise<VitalsRecordDocument> {
    // Calculate BMI if height and weight provided
    if (data.weightKg && data.heightCm) {
      const heightM = data.heightCm / 100;
      data.bmi = parseFloat((data.weightKg / (heightM * heightM)).toFixed(1));
      if (data.bmi < 18.5) data.bmiStatus = 'Underweight';
      else if (data.bmi <= 24.9) data.bmiStatus = 'Normal';
      else if (data.bmi <= 29.9) data.bmiStatus = 'Overweight';
      else data.bmiStatus = 'Obese';
    }

    // Determine clinical status
    if (data.bpSystolic >= 160 || data.bpDiastolic >= 100 || (data.spo2 && data.spo2 < 90)) {
      data.status = 'Critical';
    } else if (
      data.bpSystolic >= 140 ||
      data.bpDiastolic >= 90 ||
      (data.heartRate && data.heartRate > 100) ||
      (data.temperature && data.temperature > 100)
    ) {
      data.status = 'Warning';
    } else {
      data.status = 'Normal';
    }

    const record = new this.vitalsModel(data);
    return record.save();
  }
}
