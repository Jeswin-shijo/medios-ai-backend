import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import type { Actor } from '../beds/actor';
import { UserRole } from '../users/schemas/user.schema';
import { ROOMS, RoomKind, roomByKey } from './scheduling-catalogue';
import { SchedulingSettingsService } from './scheduling-settings.service';
import { RoomBlock, RoomBlockDocument } from './schemas/room-block.schema';

const REASON_MAX = 300;
const BLOCK_LIMIT = 200;

export interface RoomBlockView {
  id: string;
  room: string;
  from: string;
  to: string;
  reason: string;
  by: string;
}

export interface RoomView {
  key: string;
  name: string;
  kind: RoomKind;
  open: string;
  close: string;
  turnover: number;
  /** Blocks that have not ended yet, earliest first. */
  blocks: RoomBlockView[];
}

const iso = (d: Date) => new Date(d).toISOString();

/** The rooms with their hours, and the blocks an admin puts on them (maintenance, deep clean). Admin checks are in the routes and here. */
@Injectable()
export class SchedulingRoomsService {
  constructor(
    @InjectModel(RoomBlock.name) private readonly blocks: Model<RoomBlockDocument>,
    private readonly settings: SchedulingSettingsService,
  ) {}

  private view(b: RoomBlockDocument | (RoomBlock & { _id: unknown })): RoomBlockView {
    return { id: String((b as { _id: unknown })._id), room: b.room, from: iso(b.from), to: iso(b.to), reason: b.reason ?? '', by: b.by?.name ?? '' };
  }

  async rooms(): Promise<RoomView[]> {
    const cfg = await this.settings.get();
    const rows = await this.blocks.find({ to: { $gt: new Date() } }).sort({ from: 1 }).limit(BLOCK_LIMIT).lean().exec();
    return ROOMS.map((r) => {
      const hours = cfg.roomHours[r.key] ?? { open: r.open, close: r.close, turnover: r.turnover };
      return {
        key: r.key,
        name: r.name,
        kind: r.kind,
        open: hours.open,
        close: hours.close,
        turnover: hours.turnover,
        blocks: rows.filter((b) => b.room === r.key).map((b) => this.view(b as never)),
      };
    });
  }

  async addBlock(actor: Actor, roomKey: string, input: { from: Date; to: Date; reason?: string }): Promise<RoomBlockView> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can block a room.');
    if (!roomByKey(roomKey)) throw new NotFoundException('Room not found');
    const from = new Date(input.from);
    const to = new Date(input.to);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new BadRequestException('Give the block a start and an end.');
    if (to.getTime() <= from.getTime()) throw new BadRequestException('A block must end after it starts.');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length > REASON_MAX) throw new BadRequestException(`A reason is at most ${REASON_MAX} characters.`);
    const created = await this.blocks.create({ room: roomKey, from, to, reason, by: { id: actor.id, name: actor.name } });
    return this.view(created.toObject() as never);
  }

  async removeBlock(actor: Actor, id: string): Promise<{ removed: true }> {
    if (actor?.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can remove a room block.');
    if (!isValidObjectId(id)) throw new NotFoundException('Block not found');
    const gone = await this.blocks.findByIdAndDelete(id).lean().exec();
    if (!gone) throw new NotFoundException('Block not found');
    return { removed: true };
  }
}
