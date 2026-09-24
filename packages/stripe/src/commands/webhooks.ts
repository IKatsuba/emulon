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
  listDeliveries,
  listDestinations,
  setDestination,
} from 'emulon';
import { defineCommand, type EventRecord } from 'emulon';
import { z } from 'zod';
import type { Store } from '../model/core.ts';
import {
  endpointVersion,
  type EventInput,
  type EventType,
  eventTypes,
  subscriptionPolicy,
} from '../webhooks/mod.ts';
import { readConfig, unsupportedVersion } from '../versions/select.ts';
import type { StripeVersionModule } from '../versions/types.ts';

type Operation<Input, Output> = ReturnType<
  typeof defineCommand<z.ZodType<Input, Input>, z.ZodType<Output>>
>;

/** A webhook endpoint as configured, with its pinned API version. */
export type EndpointInput = Omit<Destination, 'provider'> & {
  apiVersion?: string | undefined;
};
export type EndpointView = Omit<Destination, 'secret' | 'provider'> & {
  apiVersion: string;
};

type PublishInput = { type: EventType; data: EventInput };
export type Commands = {
  'webhooks.configure': Operation<EndpointInput, EndpointView>;
  'webhooks.destinations': Operation<Record<string, never>, EndpointView[]>;
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

export const endpointInputSchema: z.ZodType<EndpointInput, EndpointInput> = z
  .strictObject({
    id: z.string(),
    url: z.string(),
    secret: z.string(),
    types: z.array(z.string()),
    enabled: z.boolean(),
    apiVersion: z.string().min(1).optional(),
  }).superRefine(({ apiVersion: _, ...destination }, ctx) => {
    // The shared schema stays the single authority on destinations.
    const shared = destinationSchema.safeParse(destination);

    for (const issue of shared.error?.issues ?? []) {
      ctx.addIssue({
        code: 'custom',
        path: issue.path,
        message: issue.message,
      });
    }

    if (destination.secret.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['secret'],
        message: 'Signing secret is required',
      });
    }
  });

const endpointViewSchema: z.ZodType<EndpointView> = z.strictObject({
  id: z.string(),
  url: z.string(),
  types: z.array(z.string()),
  enabled: z.boolean(),
  apiVersion: z.string(),
});

function view(
  { provider: _, ...destination }: Omit<Destination, 'secret'>,
  apiVersion: string,
): EndpointView {
  return { ...destination, apiVersion };
}

/** A destination whose shared settings carry the endpoint's pinned version. */
export function endpoint(
  { apiVersion, ...destination }: EndpointInput,
  version: string,
): Destination {
  return { ...destination, provider: { apiVersion: apiVersion ?? version } };
}

export function commands(
  installed: ReadonlyMap<string, StripeVersionModule>,
): Commands {
  /**
   * Normalize a provider event to its canonical fact in the version it
   * declares, which this instance must enable.
   */
  async function fact(store: Store, type: string, data: unknown) {
    const config = await store.transaction(readConfig);
    const declared = (data as { api_version?: unknown }).api_version;
    const module = typeof declared === 'string' &&
        config.versions.includes(declared)
      ? installed.get(declared)
      : undefined;

    if (module === undefined) {
      throw unsupportedVersion(config);
    }

    return { module, fact: module.parseEvent(type, data) };
  }

  const eventInput = {
    type: z.enum(eventTypes),
    // The declared version validates the body; the type keeps the envelope.
    data: z.record(z.string(), z.unknown()) as unknown as z.ZodType<
      EventInput,
      EventInput
    >,
  };

  return {
    'webhooks.send': defineCommand({
      description:
        'Send a direct webhook without changing state or selecting subscriptions',
      input: z.strictObject({
        ...eventInput,
        destination: z.string().min(1),
      }),
      output: deliverySchema,
      cli: {
        path: ['webhooks', 'send'],
        positional: 'type',
        flags: { data: 'data', destination: 'destination' },
      },
      execute: async (ctx, input) =>
        await sendWebhook(ctx.store, {
          type: input.type,
          data: (await fact(ctx.store, input.type, input.data)).fact,
          destination: input.destination,
        }),
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
      input: endpointInputSchema,
      output: endpointViewSchema,
      cli: {
        path: ['webhooks', 'configure'],
        flags: {
          id: 'id',
          url: 'url',
          secret: 'secret',
          types: 'types',
          enabled: 'enabled',
          'api-version': 'apiVersion',
        },
      },
      execute: (ctx, input) =>
        ctx.store.transaction(async (tx) => {
          const config = await readConfig(tx);
          const existing = await tx.get('emulon.destinations', input.id);
          // An endpoint keeps its version until one is supplied; a new one
          // takes the account default.
          const version = input.apiVersion ??
            (existing === undefined
              ? config.defaultVersion
              : endpointVersion(existing as Pick<Destination, 'provider'>));

          if (!config.versions.includes(version)) {
            throw unsupportedVersion(config);
          }

          // Reuse this transaction so the retained version cannot race.
          const within: Store = {
            ...ctx.store,
            transaction: (work) => work(tx),
          };

          return view(
            await setDestination(
              within,
              endpoint(input, version),
              subscriptionPolicy,
            ),
            version,
          );
        }),
    }),
    'webhooks.destinations': defineCommand({
      description: 'List webhook destinations and API versions without secrets',
      input: z.strictObject({}),
      output: z.array(endpointViewSchema),
      cli: { path: ['webhooks', 'destinations'], flags: {} },
      execute: async (ctx) =>
        (await listDestinations(ctx.store)).map((destination) =>
          view(destination, endpointVersion(destination))
        ),
    }),
    'webhooks.list': defineCommand({
      description: 'List webhook delivery records',
      input: z.strictObject({}),
      output: z.array(deliverySchema),
      cli: { path: ['webhooks', 'list'], flags: {} },
      execute: (ctx) => listDeliveries(ctx.store),
    }),
    'events.publish': defineCommand({
      description: 'Publish a synthetic event without changing state',
      input: z.strictObject(eventInput),
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
      execute: async (ctx, input) => {
        const { module, fact: payload } = await fact(
          ctx.store,
          input.type,
          input.data,
        );
        const record = await ctx.store.transaction((tx) =>
          tx.record({
            type: input.type,
            payload,
            occurredAt: new Date().toISOString(),
            origin: 'published',
          })
        );

        return { ...record, payload: module.projectEvent(input.type, payload) };
      },
    }),
  };
}
