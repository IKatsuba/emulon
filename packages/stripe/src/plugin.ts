import type { z } from 'zod';
import type {
  CompatibilityManifest,
  defineCommand,
  Destination,
  PluginContext,
} from 'emulon';
import { definePlugin, destinationFixture } from 'emulon';
import { type Commands, commands } from './commands/mod.ts';
import { endpoint } from './commands/webhooks.ts';
import { compatibility } from './compatibility.ts';
import type { EventFact } from './model/core.ts';
import { type CustomerFixture, fixtures } from './model/customers.ts';
import { routes } from './routes/api.ts';
import { checkoutPage } from './routes/checkout-page.ts';
import {
  configFixture,
  resolveVersions,
  type VersionConfig,
} from './versions/select.ts';
import type { StripeVersionModule } from './versions/types.ts';
import {
  endpointVersion,
  presentation,
  snapshotVersion,
  subscriptionPolicy,
  transport,
} from './webhooks/mod.ts';

/** Stripe API versions this package ships. */
export type ApiVersion = '2026-04-22.dahlia';

export type Options = {
  /** Versions this instance serves; only the baseline without it. */
  apiVersions?: ApiVersion[];
  /** Selected when a request has no `Stripe-Version` and for new endpoints. */
  defaultApiVersion?: ApiVersion;
  destinations?: (Omit<Destination, 'provider'> & {
    /** The endpoint's pinned version; the account default when omitted. */
    apiVersion?: ApiVersion;
  })[];
  fixtures?: { customers?: CustomerFixture[] };
};

export type Plugin = ReturnType<
  typeof definePlugin<
    Options | undefined,
    Commands & {
      'compatibility.get': ReturnType<
        typeof defineCommand<
          z.ZodObject<Record<string, never>>,
          z.ZodType<CompatibilityManifest>
        >
      >;
    }
  >
>;

/**
 * Refuse to start when retained events, endpoints or deliveries use a version this
 * instance no longer enables, instead of silently changing their projection.
 */
async function recordSelection(ctx: PluginContext, config: VersionConfig) {
  await ctx.store.transaction(async (tx) => {
    const referenced = new Set<string>();

    for (const event of await tx.outbox()) {
      referenced.add((event.payload as EventFact).apiVersion);
    }

    for (const row of await tx.list('emulon.destinations')) {
      referenced.add(endpointVersion(row.value as Destination));
    }

    // A delivery keeps the version its endpoint had when it was enqueued.
    for (const row of await tx.list('emulon.delivery-snapshots')) {
      referenced.add(snapshotVersion(row.value));
    }

    if ([...referenced].some((id) => !config.versions.includes(id))) {
      throw new Error(
        'Retained Stripe state uses an API version this instance does not enable; enable it again or reset the environment.',
      );
    }

    await tx.put(configFixture(config));
  });
}

/**
 * The Stripe plugin over a set of installed version modules. `baseline` is
 * the version served when options select none, as before versions were
 * selectable.
 */
export function createStripe(
  installed: readonly StripeVersionModule[],
  baseline: string,
): Plugin {
  const modules = new Map(installed.map((module) => [module.id, module]));
  const select = (options: Options | undefined) =>
    resolveVersions(options, [...modules.keys()], baseline);

  return definePlugin<Options | undefined, Commands>({
    name: '@emulon/stripe',
    apiVersion: 1,
    compatibility,
    capabilities: ['http', 'authorization', 'events', 'webhooks', 'reset'],
    commands: commands(modules),
    subscriptions: subscriptionPolicy,
    transport: transport(modules),
    presentation: (options) => presentation(select(options), modules),
    state: {
      pluginVersion: '0.1.0',
      // 3: semantic records, canonical event facts and neutral replays.
      schemaVersion: 3,
      fixtures: (options) => {
        const config = select(options);
        const destinations = options?.destinations ?? [];

        if (
          new Set(destinations.map((d) => d.id)).size !== destinations.length
        ) {
          throw new Error('Duplicate destination ID.');
        }

        if (
          destinations.some((d) =>
            d.apiVersion !== undefined &&
            !config.versions.includes(d.apiVersion)
          )
        ) {
          throw new Error('Destination API version is not enabled.');
        }

        return [
          configFixture(config),
          ...fixtures(options),
          ...destinations.map((d) =>
            destinationFixture(
              endpoint(d, config.defaultVersion),
              subscriptionPolicy,
            )
          ),
        ];
      },
    },
    async setup(ctx, options) {
      const config = select(options);
      let web = '';

      await recordSelection(ctx, config);
      // Session URLs name the hosted page, which listens only after routing.
      routes(
        ctx,
        ctx.http.surface('api'),
        (id) => `${web}/c/pay/${encodeURIComponent(id)}`,
        config,
        modules,
      );
      checkoutPage(ctx, ctx.http.surface('web'), config.defaultVersion);

      const api = await ctx.http.listen('api');

      web = await ctx.http.listen('web');

      return {
        endpoints: { api, web },
        ready: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      };
    },
  });
}
