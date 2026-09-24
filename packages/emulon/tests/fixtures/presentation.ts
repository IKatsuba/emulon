import { z } from 'zod';
import {
  defineCommand,
  definePlugin,
  deliveryInspectionSchema,
  deliverySchema,
  type DeliveryTransport,
  destinationViewSchema,
  inspectDelivery,
  listDestinations,
  type PluginInstance,
  type PluginPresentation,
  redeliverWebhook,
  sendWebhook,
  setDestination,
  type SubscriptionPolicy,
  waitForDelivery,
  waitTimeoutSchema,
} from 'emulon';

const policy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: ['item.saved'],
};
const encoder = new TextEncoder();

export async function sign(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(timestamp + '.' + body),
  );

  return Array.from(
    new Uint8Array(mac),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

// Fails the first attempt of every delivery, then succeeds.
const transport: DeliveryTransport = {
  timeoutMs: 5000,
  providerId: 'delivery',
  serialize: (event) => encoder.encode(JSON.stringify(event.payload)),
  async headers({ body, id, timestamp, secret }) {
    return {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'x-signature': await sign(
        secret,
        String(timestamp),
        new TextDecoder().decode(body),
      ),
    };
  },
  succeeds: (status) => status === 200,
  retryDelayMs: (attempt) => attempt === 1 ? 0 : undefined,
};

export interface Options {
  label: string;
}

function presentation({ label }: Options): PluginPresentation {
  return {
    eventView: (event) => ({ label, id: event.id, data: event.payload }),
    deliverySnapshot: (event, destination) =>
      encoder.encode(JSON.stringify({
        id: event.id,
        label,
        version: destination.provider?.version ?? null,
        data: event.payload,
      })),
  };
}

const idInput = z.strictObject({ id: z.string().min(1) });

function plugin(hooks: boolean) {
  return definePlugin({
    name: hooks ? 'presented' : 'plain',
    apiVersion: 1,
    capabilities: ['events', 'webhooks'],
    subscriptions: policy,
    transport,
    state: { pluginVersion: '1', schemaVersion: 1 },
    ...(hooks ? { presentation } : {}),
    commands: {
      'items.save': defineCommand({
        description: 'Save an item and record its event',
        input: z.strictObject({ name: z.string() }),
        output: z.strictObject({ eventId: z.string() }),
        cli: { path: ['items', 'save'], positional: 'name', flags: {} },
        execute: (ctx, { name }) =>
          ctx.store.transaction(async (tx) => {
            await tx.put({ collection: 'items', id: name, value: { name } });

            const event = await tx.record({
              type: 'item.saved',
              origin: 'service',
              occurredAt: new Date(ctx.clock.now()).toISOString(),
              payload: { name },
            });

            return { eventId: event.id };
          }),
      }),
      'webhooks.configure': defineCommand({
        description: 'Configure a destination with a provider version',
        input: z.strictObject({
          id: z.string(),
          url: z.string(),
          secret: z.string(),
          version: z.string().optional(),
        }),
        output: destinationViewSchema,
        cli: {
          path: ['webhooks', 'configure'],
          flags: { id: 'id', url: 'url', secret: 'secret', version: 'version' },
        },
        execute: (ctx, { version, ...input }) =>
          setDestination(ctx.store, {
            ...input,
            types: ['item.saved'],
            enabled: true,
            ...(version === undefined ? {} : { provider: { version } }),
          }, policy),
      }),
      'webhooks.destinations': defineCommand({
        description: 'List destinations with provider settings',
        input: z.strictObject({}),
        output: z.array(z.unknown()),
        cli: { path: ['webhooks', 'destinations'], flags: {} },
        execute: (ctx) => listDestinations(ctx.store),
      }),
      'webhooks.send': defineCommand({
        description: 'Send a direct webhook',
        input: z.strictObject({
          type: z.literal('item.saved'),
          data: z.strictObject({ name: z.string() }),
          destination: z.string(),
        }),
        output: deliverySchema,
        cli: {
          path: ['webhooks', 'send'],
          positional: 'type',
          flags: { data: 'data', destination: 'destination' },
        },
        execute: (ctx, input) => sendWebhook(ctx.store, input),
      }),
      'webhooks.redeliver': defineCommand({
        description: 'Redeliver the original body',
        input: idInput,
        output: deliverySchema,
        cli: { path: ['webhooks', 'redeliver'], positional: 'id', flags: {} },
        execute: (ctx, { id }) => redeliverWebhook(ctx.store, id),
      }),
      'webhooks.inspect': defineCommand({
        description: 'Inspect a delivery',
        input: idInput,
        output: deliveryInspectionSchema,
        cli: { path: ['webhooks', 'inspect'], positional: 'id', flags: {} },
        execute: (ctx, { id }) => inspectDelivery(ctx.store, id),
      }),
      'webhooks.wait': defineCommand({
        description: 'Wait for a delivery to succeed',
        input: z.strictObject({ id: z.string(), timeout: waitTimeoutSchema }),
        output: deliverySchema,
        cli: {
          path: ['webhooks', 'wait'],
          positional: 'id',
          flags: { timeout: 'timeout' },
        },
        execute: (ctx, { id, timeout }) =>
          waitForDelivery(ctx.store, { id, status: 'succeeded', timeout }),
      }),
      // Fixture control: hold new deliveries, then make them due explicitly.
      'webhooks.hold': defineCommand({
        description: 'Delay new deliveries by one day',
        input: z.strictObject({ hold: z.boolean() }),
        output: z.strictObject({}),
        cli: { path: ['webhooks', 'hold'], flags: { hold: 'hold' } },
        execute: async (ctx, { hold }) => {
          await ctx.store.transaction((tx) =>
            tx.put({
              collection: 'emulon.faults',
              id: 'delivery',
              value: { delayMs: hold ? 86400000 : 0, loseResponse: false },
            })
          );

          return {};
        },
      }),
      'webhooks.release': defineCommand({
        description: 'Make a held delivery due now',
        input: idInput,
        output: z.strictObject({}),
        cli: { path: ['webhooks', 'release'], positional: 'id', flags: {} },
        execute: async (ctx, { id }) => {
          await ctx.store.transaction(async (tx) => {
            const delivery = deliverySchema.parse(
              await tx.get('emulon.deliveries', id),
            );

            await tx.put({
              collection: 'emulon.deliveries',
              id,
              value: { ...delivery, nextAttemptAt: new Date(0).toISOString() },
            });
          });

          return {};
        },
      }),
    },
    setup(): Promise<PluginInstance> {
      return Promise.resolve({
        endpoints: {},
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      });
    },
  });
}

export const presented: ReturnType<typeof plugin> = plugin(true);
export const plain: ReturnType<typeof plugin> = plugin(false);
