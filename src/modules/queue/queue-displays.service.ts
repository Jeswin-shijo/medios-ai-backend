import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash, randomBytes } from 'crypto';
import { DeviceKind, QueueDisplay, QueueDisplayDocument } from './schemas/queue-display.schema';

/** Each kind has its own key prefix and Authorization scheme: `Display <key>`, `Kiosk <key>`. */
const DEVICE_AUTH: Record<DeviceKind, { prefix: string; header: RegExp; label: string }> = {
  display: { prefix: 'mqd_', header: /^Display\s+(mqd_[A-Za-z0-9_-]{32})$/, label: 'display' },
  kiosk: { prefix: 'mqk_', header: /^Kiosk\s+(mqk_[A-Za-z0-9_-]{32})$/, label: 'kiosk' },
};
const SEEN_EVERY_MS = 60_000;

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

@Injectable()
export class QueueDisplaysService {
  constructor(@InjectModel(QueueDisplay.name) private readonly displays: Model<QueueDisplayDocument>) {}

  list() {
    return this.displays.find().sort({ createdAt: 1 }).exec();
  }

  /** The key is returned only here; the server keeps its hash. */
  async create(name: string, kind: DeviceKind, actor: string, printSlips = false) {
    const key = DEVICE_AUTH[kind].prefix + randomBytes(24).toString('base64url');
    const display = await this.displays.create({
      name: name.trim(),
      kind,
      keyHash: hashKey(key),
      keyHint: key.slice(-4),
      printSlips: kind === 'kiosk' && printSlips,
      createdBy: actor,
    });
    return { display, key };
  }

  async update(id: string, changes: { name?: string; printSlips?: boolean }) {
    const display = await this.displays.findById(id).exec();
    if (!display) throw new NotFoundException('Device not found');
    if (changes.name?.trim()) display.name = changes.name.trim();
    if (changes.printSlips !== undefined && display.kind === 'kiosk') display.printSlips = changes.printSlips;
    return display.save();
  }

  async remove(id: string) {
    const removed = await this.displays.findByIdAndDelete(id).exec();
    if (!removed) throw new NotFoundException('Device not found');
    return { id, removed: true };
  }

  /** The device of `kind` presenting this Authorization header; refuses unknown or removed keys. */
  async authenticate(authorization: string | undefined, kind: DeviceKind = 'display'): Promise<QueueDisplayDocument> {
    const { header, label } = DEVICE_AUTH[kind];
    const match = header.exec(authorization ?? '');
    if (!match) throw new UnauthorizedException(`A ${label} key is required`);
    // Displays added before devices had a kind have none stored.
    const display = await this.displays.findOne({ keyHash: hashKey(match[1]), kind: kind === 'display' ? { $in: ['display', null] } : kind }).exec();
    if (!display) throw new UnauthorizedException(`This ${label} link is no longer valid. Ask an administrator for a new one.`);
    if (!display.lastSeenAt || Date.now() - display.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      await this.displays.updateOne({ _id: display._id }, { $set: { lastSeenAt: new Date() } }).exec();
    }
    return display;
  }

  async stillValid(id: unknown) {
    return !!(await this.displays.exists({ _id: id }));
  }
}
