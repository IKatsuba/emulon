import type { CompatibilityManifest } from './compatibility.ts';
import type { Hono } from 'hono';
import type { DeliveryTransport } from '../deliveries/worker.ts';
import type { Destination, SubscriptionPolicy } from '../deliveries/queue.ts';
import type {
  Entity,
  EventRecord,
  StateVersion,
  Store,
} from '../state/store.ts';
import type { Command } from '../commands/define.ts';

export type Capability =
  | 'http'
  | 'managed-engine'
  | 'authorization'
  | 'events'
  | 'webhooks'
  | 'reset'
  | 'virtual-time'
  | 'snapshot'
  | 'faults';

/** Facilities owned and cleaned up by the environment. */
export interface PluginContext {
  readonly store: Store;
  readonly clock: { now(): number };
  http: {
    surface(name: string, options?: { maxBodyBytes?: number }): Hono;
    listen(name: string): Promise<string>;
  };
}

export interface PluginDefinition<
  Options,
  Commands extends Record<string, Command>,
> {
  compatibility?: CompatibilityManifest;
  subscriptions?: SubscriptionPolicy;
  transport?: DeliveryTransport;
  state?: StateVersion & { fixtures?(options: Options): readonly Entity[] };
  /** Created from the instance options before state recovery and dispatch. */
  presentation?(options: Options): PluginPresentation;
  name: string;
  apiVersion: number;
  capabilities: readonly Capability[];
  commands: Commands;
  setup(ctx: PluginContext, options: Options): Promise<PluginInstance>;
}

/**
 * Optional provider views of committed events. Callbacks receive frozen
 * copies, must be deterministic and must not have external effects.
 */
export interface PluginPresentation {
  /** Replaces only the payload shown by event list, follow and CLI output. */
  eventView?(event: EventRecord): unknown;
  /** Exact request body, captured in the transaction that enqueues a delivery. */
  deliverySnapshot?(event: EventRecord, destination: Destination): Uint8Array;
}

export interface PluginInstance {
  endpoints: Record<string, string>;
  ready(): Promise<void>;
  stop(): Promise<void>;
}
