import type { CompatibilityManifest } from './compatibility.ts';
import type { Hono } from 'hono';
import type { DeliveryTransport } from '../deliveries/worker.ts';
import type { SubscriptionPolicy } from '../deliveries/queue.ts';
import type { Entity, StateVersion, Store } from '../state/store.ts';
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
  name: string;
  apiVersion: number;
  capabilities: readonly Capability[];
  commands: Commands;
  setup(ctx: PluginContext, options: Options): Promise<PluginInstance>;
}

export interface PluginInstance {
  endpoints: Record<string, string>;
  ready(): Promise<void>;
  stop(): Promise<void>;
}
