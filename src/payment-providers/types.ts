export type PixStatus = 'pending' | 'approved' | 'cancelled' | 'refunded' | 'expired' | 'rejected' | 'unknown';
export type PixPayment = {
  id: string; status: PixStatus; amountCents: number; externalReference: string;
  qrCode?: string; pixCopyPaste?: string; expiresAt?: string; refundedCents?: number;
};
export type CreatePixInput = {
  reference: string; idempotencyKey: string; amountCents: number; payerEmail: string;
  description?: string; expiresInSeconds?: number;
};
export interface PixGateway {
  readonly name: 'mercadopago' | 'efi';
  /** Identifies account binding, never an actual secret. */
  readonly identity: string;
  createPix(input: CreatePixInput): Promise<PixPayment>;
  getPayment(id: string): Promise<PixPayment>;
  findPaymentByReference?(reference: string): Promise<PixPayment | undefined>;
}
