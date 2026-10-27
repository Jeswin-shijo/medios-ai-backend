import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { BedRequest } from './schemas/bed-request.schema';

/** A bed request changed state: what the live stream tells open screens. */
export type BedRequestEvent = {
  id: string;
  state: BedRequest['state'];
  type: BedRequest['type'];
  patientName: string;
  bedLabel?: string;
  reason: string;
};

/**
 * Tells open bed board streams that a bed changed. In-process only: with more than
 * one API instance, a board on another instance catches up on its next refresh.
 */
@Injectable()
export class BedEvents {
  private readonly changes = new Subject<void>();
  readonly changes$ = this.changes.asObservable();
  private readonly requests = new Subject<BedRequestEvent>();
  readonly requests$ = this.requests.asObservable();

  changed() {
    this.changes.next();
  }

  requestChanged(e: BedRequestEvent) {
    this.requests.next(e);
  }
}
