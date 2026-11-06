import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { ClinicalDocument, ClinicalDocumentDocument } from './schemas/document.schema';
import { displayDateTime } from '../../common/utils/clinic-time';

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(ClinicalDocument.name)
    private docModel: Model<ClinicalDocumentDocument>,
  ) {}

  async findAll(query: { uhid?: string; category?: string; status?: string }): Promise<ClinicalDocument[]> {
    const filter: any = {};
    if (query.uhid) filter.uhid = query.uhid;
    if (query.category && query.category !== 'All' && query.category !== 'All Documents') {
      filter.category = query.category;
    }
    if (query.status && query.status !== 'All') {
      filter.status = query.status;
    }

    return this.docModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<ClinicalDocumentDocument> {
    const doc = await this.docModel.findById(id).exec();
    if (!doc) throw new NotFoundException(`Document ${id} not found`);
    return doc;
  }

  async create(data: Partial<ClinicalDocument>): Promise<ClinicalDocumentDocument> {
    const created = new this.docModel(data);
    return created.save();
  }

  async signDocument(id: string, doctorName: string): Promise<ClinicalDocumentDocument> {
    const doc = await this.findOne(id);
    doc.status = 'Signed';
    doc.signedBy = doctorName;
    doc.signedOn = displayDateTime();
    return doc.save();
  }

  /** Marks a superseded document Archived: it stays on the patient's record, never deleted. True when it changed. */
  async archive(id: string): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const res = await this.docModel.updateOne({ _id: id, status: { $ne: 'Archived' } }, { $set: { status: 'Archived' } }).exec();
    return res.modifiedCount > 0;
  }
}
