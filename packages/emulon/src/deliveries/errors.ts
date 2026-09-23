import type { DeliveryRecord } from './queue.ts';

const messages = {
  DELIVERY_NOT_FOUND: 'Webhook delivery not found.',
  DESTINATION_UNAVAILABLE: 'Webhook destination is missing or disabled.',
  DELIVERY_ACTIVE: 'Webhook delivery already has a pending attempt.',
  WAIT_CANCELLED: 'Webhook wait ended because state was reset or closed.',
  WAIT_TIMEOUT: 'Webhook wait timed out',
};

/** Only fixed diagnostics cross the command boundary; never transport text. */
export class DeliveryError extends Error {
  constructor(
    readonly code: keyof typeof messages,
    status?: DeliveryRecord['status'],
  ) {
    super(
      code === 'WAIT_TIMEOUT'
        ? `${messages[code]}; current status: ${status ?? 'unknown'}.`
        : messages[code],
    );
  }
}
