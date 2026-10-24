import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Tells open display streams that the queue changed. In-process only: with more
 * than one API instance, a display on another instance catches up on its periodic
 * refresh (see QueueController.stream).
 */
@Injectable()
export class QueueEvents {
  private readonly changes = new Subject<void>();
  readonly changes$ = this.changes.asObservable();

  changed() {
    this.changes.next();
  }
}
