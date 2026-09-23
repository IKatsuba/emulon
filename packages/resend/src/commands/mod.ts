import { type DeliveryFaults, deliveryFaultsSchema } from 'emulon';
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
import { subscriptionPolicy } from '../webhooks.ts';
import { defineCommand, type EventRecord } from 'emulon';
import { z } from 'zod';
import {
  clearEmails,
  type Email,
  emailSchema,
  getEmail,
  listEmails,
} from '../model/emails.ts';
import { createKey } from '../auth/keys.ts';

type Operation<Input, Output> = ReturnType<
  typeof defineCommand<z.ZodType<Input, Input>, z.ZodType<Output>>
>;
type EventPayload = {
  // deno-lint-ignore camelcase
  email_id: string;
  from: string;
  to: string[];
  subject: string;
};

const eventPayload: z.ZodType<EventPayload, EventPayload> = z.strictObject({
  email_id: z.uuid(),
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  subject: z.string(),
});

type PublishInput = { type: 'email.sent'; data: EventPayload };
export type Commands = {
  'webhooks.faults': Operation<DeliveryFaults, DeliveryFaults>;
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
  'emails.list': Operation<Record<string, never>, Email[]>;
  'emails.get': Operation<{ id: string }, Email | null>;
  'emails.clear': Operation<Record<string, never>, { deleted: number }>;
  'keys.create': Operation<Record<string, never>, { apiKey: string }>;
};

export const commands: Commands = {
  'webhooks.faults': defineCommand({
    description:
      'Configure delivery delay and simulated response loss for new deliveries',
    input: deliveryFaultsSchema,
    output: deliveryFaultsSchema,
    cli: {
      path: ['webhooks', 'faults'],
      flags: { 'delay-ms': 'delayMs', 'lose-response': 'loseResponse' },
    },
    async execute(ctx, input) {
      await ctx.store.transaction((tx) =>
        tx.put({ collection: 'emulon.faults', id: 'delivery', value: input })
      );

      return input;
    },
  }),
  'webhooks.send': defineCommand({
    description:
      'Send a direct webhook without changing emails or selecting subscriptions',
    input: z.strictObject({
      type: z.literal('email.sent'),
      data: eventPayload,
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
    description: 'Publish a synthetic email event without changing emails',
    input: z.strictObject({
      type: z.literal('email.sent'),
      data: eventPayload,
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
          occurredAt: new Date().toISOString(),
          origin: 'published',
        })
      ),
  }),
  'emails.list': defineCommand({
    description: 'List local sent emails',
    input: z.strictObject({}),
    output: z.array(emailSchema),
    cli: { path: ['emails', 'list'], flags: {} },
    execute: (ctx) => listEmails(ctx.store),
  }),
  'emails.get': defineCommand({
    description: 'Read a local email, or null if absent',
    input: z.strictObject({ id: z.uuid() }),
    output: emailSchema.nullable(),
    cli: { path: ['emails', 'get'], flags: { id: 'id' } },
    execute: (ctx, { id }) => getEmail(ctx.store, id),
  }),
  'emails.clear': defineCommand({
    description: 'Delete local emails while retaining the event history',
    input: z.strictObject({}),
    output: z.object({ deleted: z.number().int().nonnegative() }),
    cli: { path: ['emails', 'clear'], flags: {} },
    execute: (ctx) => clearEmails(ctx.store),
  }),
  'keys.create': defineCommand({
    description: 'Issue a local provider API key (explicit secret output)',
    input: z.strictObject({}),
    output: z.object({ apiKey: z.string() }),
    cli: { path: ['keys', 'create'], flags: {} },
    execute: (ctx) => createKey(ctx.store),
  }),
};
