import type {
  DeliveryTransport,
  Destination,
  EventRecord,
  PluginPresentation,
  SubscriptionPolicy,
} from 'emulon';
import type { EventFact, Kind } from '../model/core.ts';
import type { VersionConfig } from '../versions/select.ts';
import type { StripeVersionModule } from '../versions/types.ts';

export const eventTypes = [
  'customer.created',
  'checkout.session.completed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
] as const;

export type EventType = (typeof eventTypes)[number];

/** The resource each event type carries. */
export const eventObjects: Record<EventType, Kind> = {
  'customer.created': 'customer',
  'checkout.session.completed': 'checkout.session',
  'checkout.session.expired': 'checkout.session',
  'charge.refunded': 'charge',
  'charge.dispute.created': 'dispute',
  'charge.dispute.closed': 'dispute',
};

/**
 * The event envelope every API version shares, as commands accept it. The
 * version named by `api_version` validates the rest.
 */
export interface EventInput {
  id: string;
  object: 'event';
  'api_version': string;
  created: number;
  data: {
    object: Record<string, unknown>;
    'previous_attributes'?: Record<string, unknown>;
  };
  livemode: false;
  'pending_webhooks': number;
  request: { id: string | null; 'idempotency_key': string | null };
  type: EventType;
}

export const subscriptionPolicy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: [...eventTypes],
};

export function retryDelayMs(attempt: number): number | undefined {
  return [60000, 3600000, 7200000][attempt - 1];
}

/** The API version a webhook endpoint is pinned to. */
export function endpointVersion(
  destination: Pick<Destination, 'provider'>,
): string {
  const version = destination.provider?.apiVersion;

  if (typeof version !== 'string') {
    throw new Error('Webhook endpoint has no API version.');
  }

  return version;
}

/** The API version a captured delivery body was projected in. */
export function snapshotVersion(snapshot: unknown): string {
  const bytes = (snapshot as { bytes?: unknown } | undefined)?.bytes;
  const version = Array.isArray(bytes)
    ? (JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as {
      'api_version'?: unknown;
    }).api_version
    : undefined;

  if (typeof version !== 'string') {
    throw new Error('Webhook delivery has no API version.');
  }

  return version;
}

function body(
  module: StripeVersionModule | undefined,
  event: EventRecord,
): Uint8Array<ArrayBuffer> {
  if (module === undefined) {
    throw new Error('Stripe API version is not enabled.');
  }

  return new TextEncoder().encode(
    JSON.stringify(module.projectEvent(event.type, event.payload as EventFact)),
  );
}

/**
 * Events keep canonical facts. Event lists show each in the version of the
 * request that caused it; each delivery body is projected once, in its
 * endpoint's pinned version, and those bytes are what every attempt sends.
 */
export function presentation(
  config: VersionConfig,
  installed: ReadonlyMap<string, StripeVersionModule>,
): PluginPresentation {
  const enabled = (id: string) =>
    config.versions.includes(id) ? installed.get(id) : undefined;

  return {
    eventView(event) {
      const fact = event.payload as EventFact;
      const module = enabled(fact.apiVersion);

      if (module === undefined) {
        throw new Error('Stripe API version is not enabled.');
      }

      return module.projectEvent(event.type, fact);
    },
    deliverySnapshot: (event, destination) =>
      body(enabled(endpointVersion(destination)), event),
  };
}

export function transport(
  installed: ReadonlyMap<string, StripeVersionModule>,
): DeliveryTransport {
  return {
    timeoutMs: 5000,
    // Only reached without a captured snapshot: project the source view.
    serialize: (event) =>
      body(installed.get((event.payload as EventFact).apiVersion), event),
    async headers({ body, timestamp, secret }) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const prefix = encoder.encode(`${timestamp}.`);
      const content = new Uint8Array(prefix.length + body.length);

      content.set(prefix);
      content.set(body, prefix.length);

      const digest = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, content),
      );
      const signature = Array.from(
        digest,
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');

      return {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      };
    },
    succeeds: (status) => status >= 200 && status < 300,
    retryDelayMs,
  };
}
