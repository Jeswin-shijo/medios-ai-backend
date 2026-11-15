import { Logger } from '@nestjs/common';
import { maskPhone } from '../calls/phone';

/** Injection token; the value is null when MESSAGE_PROVIDER=none. */
export const MESSAGE_SENDER = 'MESSAGE_SENDER';

export interface MessageSender {
  readonly name: 'sample';
  send(to: string, text: string): Promise<{ ok: boolean }>;
}

/** Sends nothing: writes a masked line to the log so a demo can be followed. */
export class SampleMessageSender implements MessageSender {
  readonly name = 'sample' as const;
  private readonly logger = new Logger('SampleMessage');

  async send(to: string, text: string): Promise<{ ok: boolean }> {
    this.logger.log(`SAMPLE MESSAGE to ${maskPhone(to)}: ${text.slice(0, 80)}`);
    return { ok: true };
  }
}

export function createMessageSender(name: string): MessageSender | null {
  return name === 'sample' ? new SampleMessageSender() : null;
}
