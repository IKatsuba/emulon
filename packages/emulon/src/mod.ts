export { defineCompatibility } from './plugins/compatibility.ts';
export type { CompatibilityManifest } from './plugins/compatibility.ts';
export type { EventRecord } from './state/store.ts';
export { Emulon } from './sdk/emulon.ts';
export { defineConfig } from './sdk/config.ts';
export { definePlugin } from './plugins/define.ts';
export type {
  Capability,
  PluginContext,
  PluginDefinition,
  PluginInstance,
  PluginPresentation,
} from './plugins/types.ts';
export { defineCommand } from './commands/define.ts';
export { DomainError } from './commands/domain-error.ts';
export {
  deliverySchema,
  destinationFixture,
  destinationSchema,
  destinationViewSchema,
  listDeliveries,
  listDestinations,
  setDestination,
} from './deliveries/queue.ts';
export type {
  DeliveryRecord,
  Destination,
  JsonValue,
  ProviderSettings,
  SubscriptionPolicy,
} from './deliveries/queue.ts';

export type {
  DeliveryAttempt,
  DeliveryTransport,
} from './deliveries/worker.ts';
export { inspectAttempts } from './deliveries/worker.ts';

export {
  deliveryInspectionSchema,
  inspectDelivery,
  redeliverWebhook,
  sendWebhook,
  waitForDelivery,
  waitTimeoutSchema,
} from './deliveries/commands.ts';
export type { DeliveryInspection } from './deliveries/commands.ts';

export { deliveryFaultsSchema } from './deliveries/faults.ts';
export type { DeliveryFaults } from './deliveries/faults.ts';
