import type { SubscriptionPolicy } from 'emulon';
import type { DeliveryTransport } from 'emulon';

export const subscriptionPolicy: SubscriptionPolicy = {
  selection: 'processing-time',
  eventTypes: ['email.sent'],
};
export const transport: DeliveryTransport = {
  timeoutMs: 5000,
  serialize: (event) =>
    new TextEncoder().encode(
      JSON.stringify({
        type: event.type,
        created_at: event.occurredAt,
        data: event.payload,
      }),
    ),
  async headers({ body, id, timestamp, secret }) {
    const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
    const content = new Uint8Array(prefix.length + body.length);

    content.set(prefix);
    content.set(body, prefix.length);

    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, content),
    );

    return {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': String(timestamp),
      'svix-signature': `v1,${btoa(String.fromCharCode(...signature))}`,
    };
  },
  succeeds: (status) => status >= 200 && status < 300,
  retryDelayMs: () => undefined,
};
