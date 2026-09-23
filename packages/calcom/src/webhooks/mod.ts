import { z } from 'zod';
import type { DeliveryTransport, SubscriptionPolicy } from 'emulon';
import { type Attendee, attendeeSchema } from '../model/bookings.ts';
import {
  idSchema,
  instant,
  type Organizer,
  organizerSchema,
} from '../model/scheduling.ts';

export interface BookingPayload {
  uid: string;
  eventTypeId: number;
  title: string;
  startTime: string;
  endTime: string;
  organizer: Organizer;
  attendees: Attendee[];
}

export const payloadSchema: z.ZodType<BookingPayload, BookingPayload> = z
  .strictObject({
    uid: z.string().min(1),
    eventTypeId: idSchema,
    title: z.string(),
    startTime: instant,
    endTime: instant,
    organizer: organizerSchema,
    attendees: z.array(attendeeSchema),
  });
export const subscriptionPolicy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: ['BOOKING_CREATED'],
};
export const transport: DeliveryTransport = {
  timeoutMs: 5000,
  serialize: (event) =>
    new TextEncoder().encode(JSON.stringify({
      triggerEvent: z.literal('BOOKING_CREATED').parse(event.type),
      createdAt: event.occurredAt,
      payload: payloadSchema.parse(event.payload),
    })),
  async headers({ body, secret }) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));

    return {
      'content-type': 'application/json',
      'x-cal-webhook-version': '2021-10-20',
      'x-cal-signature-256': Array.from(
        digest,
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join(''),
    };
  },
  succeeds: (status) => status >= 200 && status < 300,
  // The selected local contract makes no claim about hosted retry timing.
  retryDelayMs: () => undefined,
};
