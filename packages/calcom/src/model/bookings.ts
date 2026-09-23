import { z } from 'zod';
import type { PluginContext } from 'emulon';
import {
  CalError,
  idSchema,
  instant,
  type Organizer,
  organizerSchema,
  storedSchema,
  utcInstant,
} from './scheduling.ts';
import { isFree } from './intervals.ts';

export interface Attendee {
  name: string;
  email: string;
  timeZone: 'UTC';
  language?: 'en' | undefined;
}
export interface BookingInput {
  eventTypeId: number;
  start: string;
  attendee: Attendee;
}
export interface Booking {
  id: number;
  uid: string;
  status: 'accepted';
  start: string;
  end: string;
  duration: number;
  eventTypeId: number;
  title: string;
  hosts: Organizer[];
  attendees: Attendee[];
}

export const attendeeSchema: z.ZodType<Attendee, Attendee> = z.strictObject({
  name: z.string().min(1),
  email: z.email(),
  timeZone: z.literal('UTC'),
  language: z.literal('en').optional(),
});
export const bookingInput: z.ZodType<BookingInput, BookingInput> = z
  .strictObject({
    eventTypeId: idSchema,
    start: instant,
    attendee: attendeeSchema,
  });
export const bookingQuery = z.strictObject({ uid: z.string().min(1) });
export const bookingSchema: z.ZodType<Booking, Booking> = z.strictObject({
  id: idSchema,
  uid: z.string().min(1),
  status: z.literal('accepted'),
  start: instant,
  end: instant,
  duration: idSchema,
  eventTypeId: idSchema,
  title: z.string(),
  hosts: z.array(organizerSchema),
  attendees: z.array(attendeeSchema),
});

type Store = PluginContext['store'];

export function createBooking(
  store: Store,
  raw: BookingInput,
  now: () => number,
): Promise<Booking> {
  const input = bookingInput.parse(raw);

  return store.transaction(async (tx) => {
    const value = await tx.get('eventTypes', String(input.eventTypeId));

    if (value === undefined) {
      throw new CalError(404, 'not_found', 'Event type not found.');
    }

    const type = storedSchema.parse(value);
    const start = utcInstant(input.start);
    const end = start + type.lengthInMinutes * 60000;
    const timestamp = now();

    if (
      start <= timestamp || !Number.isFinite(new Date(end).getTime()) ||
      !Number.isFinite(utcInstant(new Date(end).toISOString())) ||
      !type.slots.some((slot) => utcInstant(slot) === start)
    ) {
      throw new CalError(
        400,
        'invalid_request',
        'Expected a future declared slot with a valid end.',
      );
    }

    const bookings = (await tx.list('bookings')).map((row) =>
      bookingSchema.parse(row.value)
    );

    if (
      !isFree(
        { start, end },
        bookings.map((b) => ({
          start: utcInstant(b.start),
          end: utcInstant(b.end),
        })),
      )
    ) {
      throw new CalError(
        409,
        'slot_conflict',
        'The organizer is already booked for this interval.',
      );
    }

    const organizer = organizerSchema.parse(
      await tx.get('organizer', 'default'),
    );
    const booking = bookingSchema.parse({
      id: bookings.reduce((max, b) => Math.max(max, b.id), 0) + 1,
      uid: crypto.randomUUID(),
      status: 'accepted',
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      duration: type.lengthInMinutes,
      eventTypeId: type.id,
      title: type.title,
      hosts: [organizer],
      attendees: [input.attendee],
    });

    await tx.put({ collection: 'bookings', id: booking.uid, value: booking });
    await tx.record({
      type: 'BOOKING_CREATED',
      occurredAt: new Date(timestamp).toISOString(),
      origin: 'service',
      payload: {
        uid: booking.uid,
        eventTypeId: booking.eventTypeId,
        title: booking.title,
        startTime: booking.start,
        endTime: booking.end,
        organizer,
        attendees: booking.attendees,
      },
    });

    return booking;
  });
}

export function getBooking(store: Store, uid: string): Promise<Booking> {
  bookingQuery.parse({ uid });

  return store.transaction(async (tx) => {
    const value = await tx.get('bookings', uid);

    if (value === undefined) {
      throw new CalError(404, 'not_found', 'Booking not found.');
    }

    return bookingSchema.parse(value);
  });
}
