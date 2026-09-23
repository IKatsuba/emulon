import {
  type DeliveryInspection,
  deliveryInspectionSchema,
  inspectDelivery,
  redeliverWebhook,
  sendWebhook,
  waitForDelivery,
  waitTimeoutSchema,
} from 'emulon';
import {
  type DeliveryRecord,
  deliverySchema,
  type Destination,
  destinationSchema,
  destinationViewSchema,
  listDeliveries,
  listDestinations,
  setDestination,
} from 'emulon';
import { subscriptionPolicy } from '../webhooks/mod.ts';
import { defineCommand, type EventRecord } from 'emulon';
import { z } from 'zod';
import { type BookingPayload, payloadSchema } from '../webhooks/mod.ts';

type Operation<Input, Output> = ReturnType<
  typeof defineCommand<z.ZodType<Input, Input>, z.ZodType<Output>>
>;
type PublishInput = { type: 'BOOKING_CREATED'; data: BookingPayload };
export type Commands = {
  'webhooks.configure': Operation<Destination, Omit<Destination, 'secret'>>;
  'webhooks.destinations': Operation<
    Record<string, never>,
    Omit<Destination, 'secret'>[]
  >;
  'webhooks.send': Operation<
    PublishInput & { destination: string },
    DeliveryRecord
  >;
  'webhooks.inspect': Operation<{ id: string }, DeliveryInspection>;
  'webhooks.redeliver': Operation<{ id: string }, DeliveryRecord>;
  'webhooks.wait': Operation<
    { id: string; status: DeliveryRecord['status']; timeout: string },
    DeliveryRecord
  >;
  'webhooks.list': Operation<Record<string, never>, DeliveryRecord[]>;
  'events.publish': Operation<PublishInput, EventRecord>;
};

export const commands: Commands = {
  'webhooks.send': defineCommand({
    description:
      'Send a direct webhook without booking slots or selecting subscriptions',
    input: z.strictObject({
      type: z.literal('BOOKING_CREATED'),
      data: payloadSchema,
      destination: z.string().min(1),
    }),
    output: deliverySchema,
    cli: {
      path: ['webhooks', 'send'],
      positional: 'type',
      flags: { data: 'data', destination: 'destination' },
    },
    execute: (ctx, input) => sendWebhook(ctx.store, input),
  }),
  'webhooks.inspect': defineCommand({
    description:
      'Inspect a delivery and its attempts without credentials or response bodies',
    input: z.strictObject({ id: z.string().min(1) }),
    output: deliveryInspectionSchema,
    cli: { path: ['webhooks', 'inspect'], positional: 'id', flags: {} },
    execute: (ctx, { id }) => inspectDelivery(ctx.store, id),
  }),
  'webhooks.redeliver': defineCommand({
    description: 'Queue another attempt with the original webhook body',
    input: z.strictObject({ id: z.string().min(1) }),
    output: deliverySchema,
    cli: { path: ['webhooks', 'redeliver'], positional: 'id', flags: {} },
    execute: (ctx, { id }) => redeliverWebhook(ctx.store, id),
  }),
  'webhooks.wait': defineCommand({
    description: 'Wait for a delivery status through committed state changes',
    input: z.strictObject({
      id: z.string().min(1),
      status: z.enum([
        'queued',
        'in-flight',
        'succeeded',
        'failed',
        'cancelled',
      ]),
      timeout: waitTimeoutSchema,
    }),
    output: deliverySchema,
    cli: {
      path: ['webhooks', 'wait'],
      positional: 'id',
      flags: { status: 'status', timeout: 'timeout' },
    },
    execute: (ctx, input) => waitForDelivery(ctx.store, input),
  }),
  'webhooks.configure': defineCommand({
    description:
      'Create or replace a webhook destination; disabling cancels queued deliveries',
    input: destinationSchema.refine(
      (value) => value.secret.length > 0,
      'Signing secret is required',
    ),
    output: destinationViewSchema,
    cli: {
      path: ['webhooks', 'configure'],
      flags: {
        id: 'id',
        url: 'url',
        secret: 'secret',
        types: 'types',
        enabled: 'enabled',
      },
    },
    execute: (ctx, input) =>
      setDestination(ctx.store, input, subscriptionPolicy),
  }),
  'webhooks.destinations': defineCommand({
    description: 'List webhook destinations without secrets',
    input: z.strictObject({}),
    output: z.array(destinationViewSchema),
    cli: { path: ['webhooks', 'destinations'], flags: {} },
    execute: (ctx) => listDestinations(ctx.store),
  }),
  'webhooks.list': defineCommand({
    description: 'List webhook delivery records',
    input: z.strictObject({}),
    output: z.array(deliverySchema),
    cli: { path: ['webhooks', 'list'], flags: {} },
    execute: (ctx) => listDeliveries(ctx.store),
  }),
  'events.publish': defineCommand({
    description: 'Publish a synthetic booking event without booking slots',
    input: z.strictObject({
      type: z.literal('BOOKING_CREATED'),
      data: payloadSchema,
    }),
    output: z.object({
      id: z.string(),
      instanceId: z.string(),
      type: z.string(),
      occurredAt: z.string(),
      origin: z.enum(['service', 'published', 'direct']),
      payload: z.unknown(),
    }),
    cli: {
      path: ['events', 'publish'],
      positional: 'type',
      flags: { data: 'data' },
    },
    execute: (ctx, input) =>
      ctx.store.transaction((tx) =>
        tx.record({
          type: input.type,
          payload: input.data,
          occurredAt: new Date(ctx.clock.now()).toISOString(),
          origin: 'published',
        })
      ),
  }),
};
