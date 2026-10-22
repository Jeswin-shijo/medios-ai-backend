import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Medication, MedicationDocument } from './schemas/medication.schema';

@Injectable()
export class MedicationsService {
  constructor(
    @InjectModel(Medication.name)
    private medicationModel: Model<MedicationDocument>,
  ) {}

  async findAll(query: { uhid?: string; status?: string }): Promise<Medication[]> {
    const filter: any = {};
    if (query.uhid) filter.uhid = query.uhid;
    if (query.status && query.status !== 'All') filter.status = query.status;

    return this.medicationModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<MedicationDocument> {
    const med = await this.medicationModel.findById(id).exec();
    if (!med) throw new NotFoundException(`Medication ${id} not found`);
    return med;
  }

  async create(data: Partial<Medication>): Promise<MedicationDocument> {
    const med = new this.medicationModel(data);
    return med.save();
  }

  async updateStatus(id: string, status: string): Promise<MedicationDocument> {
    const med = await this.findOne(id);
    med.status = status;
    return med.save();
  }

  async getAdherence(uhid: string) {
    const meds = await this.medicationModel.find({ uhid }).exec();
    const active = meds.filter(m => m.status === 'Active');
    const paused = meds.filter(m => m.status === 'Paused');
    const stopped = meds.filter(m => m.status === 'Stopped');
    const completed = meds.filter(m => m.status === 'Completed');

    // Average only over medications whose adherence has actually been measured.
    const scored = meds.filter(m => typeof m.adherenceScore === 'number');
    const avgScore = scored.length
      ? Math.round(scored.reduce((acc, m) => acc + m.adherenceScore!, 0) / scored.length)
      : null;

    return {
      uhid,
      overallScore: avgScore,
      rating:
        avgScore === null
          ? null
          : avgScore >= 90 ? 'Excellent' : avgScore >= 75 ? 'Good' : 'Needs Improvement',
      medications: scored.map(m => ({ id: String(m._id), medicine: m.medicine, score: m.adherenceScore })),
      counts: {
        total: meds.length,
        active: active.length,
        paused: paused.length,
        stopped: stopped.length,
        completed: completed.length,
      },
    };
  }
}
