import { newSecret } from '../format';

/** Injection token; the value is null when PAYMENT_PROVIDER=none (cash only). */
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

/** A UPI handle that cannot receive money, so a sample QR is safe to scan. */
export const SAMPLE_UPI_PAYEE = 'medios.sample@sample';

const ORDER_MINUTES = 5;

export interface PaymentProvider {
  readonly name: 'sample';
  createUpiOrder(i: { visitId: string; amount: number; payeeName: string }): Promise<{ orderId: string; upiUri: string; expiresAt: Date }>;
  createCardRequest(i: { visitId: string; amount: number }): Promise<{ orderId: string; expiresAt: Date }>;
}

/** Charges nothing: UPI links point at a payee that does not exist, and payments are simulated. */
export class SamplePaymentProvider implements PaymentProvider {
  readonly name = 'sample' as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async createUpiOrder({ amount, payeeName }: { visitId: string; amount: number; payeeName: string }) {
    const orderId = `SAMPLE-${newSecret(6)}`;
    const upiUri =
      `upi://pay?pa=${SAMPLE_UPI_PAYEE}&pn=${encodeURIComponent(payeeName)}&am=${amount.toFixed(2)}` +
      `&tr=${orderId}&tn=OP%20consultation%20(SAMPLE)&cu=INR`;
    return { orderId, upiUri, expiresAt: this.expiry() };
  }

  async createCardRequest(_: { visitId: string; amount: number }) {
    return { orderId: `SAMPLE-${newSecret(6)}`, expiresAt: this.expiry() };
  }

  private expiry() {
    return new Date(this.now().getTime() + ORDER_MINUTES * 60 * 1000);
  }
}

export function createPaymentProvider(name: string): PaymentProvider | null {
  return name === 'sample' ? new SamplePaymentProvider() : null;
}
