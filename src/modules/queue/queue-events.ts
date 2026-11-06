import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Tells open display streams that the queue changed, and the Revenue Agent which token was marked done. In-process only:
 * with more than one API instance, a display on another instance catches up on its periodic refresh (see
 * QueueController.stream), and Revenue's minute pass settles what a missed event left (R30).
 */
@Injectable()
export class QueueEvents {
  private readonly changes = new Subject<void>();
  readonly changes$ = this.changes.asObservable();

  private readonly completions = new Subject<string>();
  /** The id of a token just marked done: its patient has been seen. */
  readonly completed$ = this.completions.asObservable();

  changed() {
    this.changes.next();
  }

  tokenCompleted(tokenId: string) {
    this.completions.next(tokenId);
  }
}
