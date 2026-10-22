import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Patient, PatientDocument } from './schemas/patient.schema';
import { CreatePatientDto } from './dto/create-patient.dto';
import { escapeRegex } from '../../common/utils/escape-regex';

@Injectable()
export class PatientsService {
  constructor(
    @InjectModel(Patient.name) private patientModel: Model<PatientDocument>,
  ) {}

  async findAll(query: {
    search?: string;
    status?: string;
    visitType?: string;
    department?: string;
    limit?: number;
    skip?: number;
  }): Promise<{ patients: Patient[]; total: number }> {
    const filter: any = {};

    if (query.search) {
      filter.$or = [
        { name: { $regex: escapeRegex(query.search), $options: 'i' } },
        { uhid: { $regex: escapeRegex(query.search), $options: 'i' } },
        { phone: { $regex: escapeRegex(query.search), $options: 'i' } },
      ];
    }

    if (query.status && query.status !== 'All') {
      filter.status = query.status;
    }

    if (query.visitType && query.visitType !== 'All') {
      filter.visitType = query.visitType;
    }

    if (query.department && query.department !== 'All') {
      filter.department = query.department;
    }

    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500); // capped: one request cannot dump the collection
    const skip = Math.max(Number(query.skip) || 0, 0);

    const [patients, total] = await Promise.all([
      this.patientModel.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).exec(),
      this.patientModel.countDocuments(filter).exec(),
    ]);

    return { patients, total };
  }

  async findOne(idOrUhid: string): Promise<PatientDocument> {
    let patient: PatientDocument | null = null;
    if (isValidObjectId(idOrUhid)) {
      patient = await this.patientModel.findById(idOrUhid).exec();
    }
    if (!patient) {
      patient = await this.patientModel.findOne({ uhid: idOrUhid }).exec();
    }
    if (!patient) {
      throw new NotFoundException(`Patient with ID or UHID ${idOrUhid} not found`);
    }
    return patient;
  }

  async create(createPatientDto: CreatePatientDto): Promise<PatientDocument> {
    if (createPatientDto.uhid) {
      return new this.patientModel(createPatientDto).save();
    }
    // Assign the next UHID in the MHK<year><5-digit serial> series, retrying if a
    // concurrent registration took the same number.
    for (let attempt = 0; ; attempt++) {
      try {
        return await new this.patientModel({ ...createPatientDto, uhid: await this.nextUhid() }).save();
      } catch (err) {
        if (attempt < 2 && (err as { code?: number })?.code === 11000) continue;
        throw err;
      }
    }
  }

  private async nextUhid(): Promise<string> {
    const prefix = `MHK${new Date().getFullYear()}`;
    const last = await this.patientModel
      .findOne({ uhid: { $regex: `^${prefix}\\d{5}$` } })
      .sort({ uhid: -1 })
      .select('uhid')
      .exec();
    const serial = last ? Number(last.uhid.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(serial).padStart(5, '0')}`;
  }

  async update(idOrUhid: string, updates: Partial<Patient>): Promise<PatientDocument> {
    const patient = await this.findOne(idOrUhid);
    Object.assign(patient, updates);
    return patient.save();
  }

  async remove(idOrUhid: string): Promise<{ success: boolean; message: string }> {
    const patient = await this.findOne(idOrUhid);
    await this.patientModel.deleteOne({ _id: patient._id }).exec();
    return { success: true, message: `Patient ${patient.name} (${patient.uhid}) removed` };
  }

  async countTotal(): Promise<number> {
    return this.patientModel.countDocuments().exec();
  }
}
