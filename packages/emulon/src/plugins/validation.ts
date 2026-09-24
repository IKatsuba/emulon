import { defineCompatibility } from './compatibility.ts';
import { commandEntries } from '../commands/registry.ts';
import type { Capability } from './types.ts';

const capabilities: ReadonlySet<Capability> = new Set([
  'http',
  'managed-engine',
  'authorization',
  'events',
  'webhooks',
  'reset',
  'virtual-time',
  'snapshot',
  'faults',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateDefinition(value: unknown): void {
  if (!isRecord(value)) {
    throw new TypeError('Plugin definition must be an object.');
  }

  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    throw new TypeError('Plugin definition.name must be a non-empty string.');
  }

  if (!Number.isInteger(value.apiVersion) || (value.apiVersion as number) < 1) {
    throw new TypeError(
      'Plugin definition.apiVersion must be a positive integer.',
    );
  }

  if (value.apiVersion !== 1) {
    throw new TypeError(
      `Plugin contract mismatch: required apiVersion 1, actual ${value.apiVersion}.`,
    );
  }

  if (
    !Array.isArray(value.capabilities) ||
    Array.from(value.capabilities).some((item) => !capabilities.has(item))
  ) {
    throw new TypeError(
      'Plugin definition.capabilities must be an array of supported capabilities.',
    );
  }

  if (!isRecord(value.commands)) {
    throw new TypeError('Plugin definition.commands must be an object.');
  }

  if (value.state !== undefined) {
    if (
      !isRecord(value.state) || typeof value.state.pluginVersion !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,63}$/.test(value.state.pluginVersion) ||
      !Number.isSafeInteger(value.state.schemaVersion) ||
      (value.state.schemaVersion as number) < 1 ||
      (value.state.fixtures !== undefined &&
        typeof value.state.fixtures !== 'function')
    ) {
      throw new TypeError(
        'Plugin state requires a valid pluginVersion, positive schemaVersion and optional fixtures function.',
      );
    }
  }

  if (value.subscriptions !== undefined) {
    const policy = value.subscriptions;

    if (
      !isRecord(policy) || policy.selection !== 'processing-time' ||
      !Array.isArray(policy.eventTypes) || !policy.eventTypes.length ||
      !policy.eventTypes.every((type) =>
        typeof type === 'string' && type.length > 0
      ) ||
      !value.capabilities.includes('webhooks')
    ) {
      throw new TypeError('Invalid plugin subscription policy.');
    }
  }

  if (
    value.presentation !== undefined &&
    typeof value.presentation !== 'function'
  ) {
    throw new TypeError('Plugin definition.presentation must be a function.');
  }

  if (value.compatibility !== undefined) {
    const manifest = defineCompatibility(value.compatibility);

    if (
      manifest.plugin !== value.name ||
      JSON.stringify([...manifest.capabilities].sort()) !==
        JSON.stringify([...value.capabilities].sort())
    ) {
      throw new TypeError(
        'Compatibility plugin name or capabilities mismatch.',
      );
    }
  }

  commandEntries(value.commands);

  if (typeof value.setup !== 'function') {
    throw new TypeError('Plugin definition.setup must be a function.');
  }
}
