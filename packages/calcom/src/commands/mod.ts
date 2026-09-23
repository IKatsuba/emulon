import {
  type Commands as WebhookCommands,
  commands as webhookCommands,
} from './webhooks.ts';
import {
  type Booking,
  type BookingInput,
  bookingInput,
  bookingQuery,
  bookingSchema,
  createBooking,
  getBooking,
} from '../model/bookings.ts';
import { defineCommand } from 'emulon';
import { z } from 'zod';
import { createKey } from '../auth/keys.ts';
import {
  createEventType,
  type CreateInput,
  createInput,
  type EventType,
  eventTypeSchema,
  getEventType,
  idSchema,
  listEventTypes,
  listSlots,
  queryInput,
  type SlotQuery,
  type Slots,
  slotsSchema,
} from '../model/scheduling.ts';

type Operation<I, O> = ReturnType<
  typeof defineCommand<z.ZodType<I, I>, z.ZodType<O, O>>
>;
export type Commands = WebhookCommands & {
  'bookings.create': Operation<BookingInput, Booking>;
  'bookings.get': Operation<{ uid: string }, Booking>;
  'eventTypes.create': Operation<CreateInput, EventType>;
  'eventTypes.get': Operation<{ id: number }, EventType>;
  'eventTypes.list': Operation<Record<string, never>, EventType[]>;
  'slots.list': Operation<SlotQuery, Slots>;
  'keys.create': Operation<Record<string, never>, { apiKey: string }>;
};

export const commands: Commands = {
  ...webhookCommands,
  'bookings.create': defineCommand({
    description: 'Book a future declared UTC slot and record BOOKING_CREATED',
    input: bookingInput,
    output: bookingSchema,
    cli: {
      path: ['bookings', 'create'],
      flags: {
        'event-type-id': 'eventTypeId',
        start: 'start',
        attendee: 'attendee',
      },
    },
    execute: (ctx, input) => createBooking(ctx.store, input, ctx.clock.now),
  }),
  'bookings.get': defineCommand({
    description: 'Read a booking by UID',
    input: bookingQuery,
    output: bookingSchema,
    cli: { path: ['bookings', 'get'], flags: { uid: 'uid' } },
    execute: (ctx, { uid }) => getBooking(ctx.store, uid),
  }),
  'eventTypes.create': defineCommand({
    description: 'Create an individual event type with fixed UTC slots',
    input: createInput,
    output: eventTypeSchema,
    cli: {
      path: ['event-types', 'create'],
      flags: {
        title: 'title',
        slug: 'slug',
        'length-in-minutes': 'lengthInMinutes',
        slots: 'slots',
      },
    },
    execute: (ctx, input) => createEventType(ctx.store, input),
  }),
  'eventTypes.get': defineCommand({
    description: 'Read an event type',
    input: z.strictObject({ id: idSchema }),
    output: eventTypeSchema,
    cli: { path: ['event-types', 'get'], flags: { id: 'id' } },
    execute: (ctx, { id }) => getEventType(ctx.store, id),
  }),
  'eventTypes.list': defineCommand({
    description: 'List event types',
    input: z.strictObject({}),
    output: z.array(eventTypeSchema),
    cli: { path: ['event-types', 'list'], flags: {} },
    execute: (ctx) => listEventTypes(ctx.store),
  }),
  'slots.list': defineCommand({
    description: 'List future declared UTC slots',
    input: queryInput,
    output: slotsSchema,
    cli: {
      path: ['slots', 'list'],
      flags: {
        'event-type-id': 'eventTypeId',
        start: 'start',
        end: 'end',
        'time-zone': 'timeZone',
      },
    },
    execute: (ctx, input) => listSlots(ctx.store, input, ctx.clock.now),
  }),
  'keys.create': defineCommand({
    description: 'Issue a local Cal.com API key',
    input: z.strictObject({}),
    output: z.object({ apiKey: z.string() }),
    cli: { path: ['keys', 'create'], flags: {} },
    execute: (ctx) => createKey(ctx.store),
  }),
};
