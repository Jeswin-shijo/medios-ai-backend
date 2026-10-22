import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Appointment, AppointmentDocument } from './schemas/appointment.schema';
import { clockMinutes, isoDate } from '../../common/utils/clinic-time';

@Injectable()
export class AppointmentsService {
  constructor(
    @InjectModel(Appointment.name)
    private appointmentModel: Model<AppointmentDocument>,
  ) {}

  async findAll(query: {
    date?: string;
    status?: string;
    uhid?: string;
    search?: string;
    limit?: number;
    skip?: number;
  }): Promise<{ appointments: Appointment[]; total: number }> {
    const filter: any = {};

    if (query.date) {
      filter.date = query.date;
    }

    if (query.status && query.status !== 'All') {
      filter.status = query.status;
    }

    if (query.uhid) {
      filter.uhid = query.uhid;
    }

    if (query.search) {
      filter.$or = [
        { patientName: { $regex: query.search, $options: 'i' } },
        { uhid: { $regex: query.search, $options: 'i' } },
        { condition: { $regex: query.search, $options: 'i' } },
      ];
    }

    const limit = query.limit || 100;
    const skip = query.skip || 0;

    const [appointments, total] = await Promise.all([
      this.appointmentModel.find(filter).sort({ time: 1 }).skip(skip).limit(limit).exec(),
      this.appointmentModel.countDocuments(filter).exec(),
    ]);

    return { appointments, total };
  }

  /** The day's queue in clock order ("02:00 PM" after "09:30 AM"). */
  async findToday(day: Date = new Date()): Promise<Appointment[]> {
    const appointments = await this.appointmentModel.find({ date: isoDate(day) }).exec();
    return appointments.sort((a, b) => clockMinutes(a.time) - clockMinutes(b.time));
  }

  async findOne(id: string): Promise<AppointmentDocument> {
    const appointment = await this.appointmentModel.findById(id).exec();
    if (!appointment) {
      throw new NotFoundException(`Appointment ${id} not found`);
    }
    return appointment;
  }

  async create(data: Partial<Appointment>): Promise<AppointmentDocument> {
    const created = new this.appointmentModel(data);
    return created.save();
  }

  async updateStatus(id: string, status: string): Promise<AppointmentDocument> {
    const appointment = await this.findOne(id);
    appointment.status = status;
    if (status === 'Checked In' && !appointment.checkedInTime) {
      const now = new Date();
      appointment.checkedInTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return appointment.save();
  }

  async update(id: string, updates: Partial<Appointment>): Promise<AppointmentDocument> {
    const appointment = await this.findOne(id);
    Object.assign(appointment, updates);
    return appointment.save();
  }

  async remove(id: string): Promise<{ success: boolean; message: string }> {
    const appointment = await this.findOne(id);
    await this.appointmentModel.deleteOne({ _id: appointment._id }).exec();
    return { success: true, message: `Appointment ${id} deleted` };
  }
}
