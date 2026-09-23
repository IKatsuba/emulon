import {
  type DeliveryTransport,
  destinationFixture,
  type SubscriptionPolicy,
} from 'emulon';
import { z } from 'zod';
import type { Options } from '../model/schema.ts';

export const subscriptionPolicy: SubscriptionPolicy = {
  selection: 'processing-time',
  allowUnsigned: true,
  eventTypes: ['issues.opened'],
};

export interface IssueEventPayload extends Record<string, unknown> {
  action?: 'opened' | undefined;
  issue: { id: number; number: number; title: string; [key: string]: unknown };
  repository: {
    id: number;
    name: string;
    // deno-lint-ignore camelcase
    full_name: string;
    private: boolean;
    [key: string]: unknown;
  };
  sender: {
    id: number;
    login: string;
    type: 'Bot' | 'User' | 'Organization';
    [key: string]: unknown;
  };
  installation?: { id: number; [key: string]: unknown } | undefined;
}

// Synthetic events supply their own projections; no resource lookup is needed.
export const issueEventPayload: z.ZodType<
  IssueEventPayload,
  IssueEventPayload
> = z.object({
  action: z.literal('opened').optional(),
  issue: z.object({
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    title: z.string(),
  }).passthrough(),
  repository: z.object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    full_name: z.string().min(1),
    private: z.boolean(),
  }).passthrough(),
  sender: z.object({
    id: z.number().int().nonnegative(),
    login: z.string().min(1),
    type: z.enum(['Bot', 'User', 'Organization']),
  }).passthrough(),
  installation: z.object({ id: z.number().int().positive() }).passthrough()
    .optional(),
}).passthrough();

export function providerEvent(type: string, payload: unknown) {
  if (type !== 'issues.opened') {
    throw new Error('Unsupported GitHub event type.');
  }

  return {
    name: 'issues',
    payload: { ...issueEventPayload.parse(payload), action: 'opened' as const },
  };
}

export function webhookFixtures(options?: Options) {
  if (!options?.webhooks) {
    return [];
  }

  return [destinationFixture({
    id: 'github',
    url: options.webhooks.url,
    secret: options.webhooks.secret ?? '',
    types: [...subscriptionPolicy.eventTypes],
    enabled: true,
  }, subscriptionPolicy)];
}

export async function signature(
  body: Uint8Array<ArrayBuffer>,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));

  return `sha256=${
    Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }`;
}

export const transport: DeliveryTransport = {
  timeoutMs: 10000,
  providerId: 'attempt',
  serialize: (event) =>
    new TextEncoder().encode(
      JSON.stringify(providerEvent(event.type, event.payload).payload),
    ),
  async headers({ body, id, secret }) {
    return {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-github-delivery': id,
      ...(secret
        ? { 'x-hub-signature-256': await signature(body, secret) }
        : {}),
    };
  },
  succeeds: (status) => status >= 200 && status < 300,
  retryDelayMs: () => undefined,
};
