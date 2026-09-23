import {
  defineCommand,
  type DeliveryInspection,
  deliveryInspectionSchema,
  type DeliveryRecord,
  deliverySchema,
  type EventRecord,
  inspectDelivery,
  listDeliveries,
  redeliverWebhook,
  sendWebhook,
  waitForDelivery,
  waitTimeoutSchema,
} from 'emulon';
import { z } from 'zod';
import { type IssueEventPayload, issueEventPayload } from '../webhooks/mod.ts';

type Operation<Input, Output> = ReturnType<
  typeof defineCommand<z.ZodType<Input, Input>, z.ZodType<Output>>
>;
type PublishInput = {
  type: 'issues.opened';
  data: IssueEventPayload;
};
export type WebhookCommands = {
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

export const webhookCommands: WebhookCommands = {
  'webhooks.send': defineCommand({
    description:
      'Send a direct webhook without changing GitHub resources or selecting subscriptions',
    input: z.strictObject({
      type: z.literal('issues.opened'),
      data: issueEventPayload,
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
  'webhooks.list': defineCommand({
    description: 'List webhook delivery records',
    input: z.strictObject({}),
    output: z.array(deliverySchema),
    cli: { path: ['webhooks', 'list'], flags: {} },
    execute: (ctx) => listDeliveries(ctx.store),
  }),
  'events.publish': defineCommand({
    description:
      'Publish a synthetic issue event without changing GitHub resources',
    input: z.strictObject({
      type: z.literal('issues.opened'),
      data: issueEventPayload,
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
};
