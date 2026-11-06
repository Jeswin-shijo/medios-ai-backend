import { Logger } from '@nestjs/common';
import { maskPhone } from '../format';

/** Injection token; the value is null when SMS_PROVIDER=none. */
export const SMS_PROVIDER = 'SMS_PROVIDER';

export interface SmsProvider {
  readonly name: 'sample';
  sendOtp(phone10: string, code: string): Promise<void>;
}

/** Sends nothing: writes the code to the log so a demo can be followed. */
export class SampleSmsProvider implements SmsProvider {
  readonly name = 'sample' as const;
  private readonly logger = new Logger('SampleSms');

  async sendOtp(phone10: string, code: string): Promise<void> {
    this.logger.log(`SAMPLE SMS to ${maskPhone(phone10).replace(' ', '')}: code ${code}`);
  }
}

export function createSmsProvider(name: string): SmsProvider | null {
  return name === 'sample' ? new SampleSmsProvider() : null;
}
