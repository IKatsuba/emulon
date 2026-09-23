import { validateCoreFormat } from '../src/state/core-format.ts';
import type { Snapshot } from '../src/state/store.ts';

const attempt = {
  id: 'attempt',
  deliveryId: 'delivery',
  startedAt: '2026-09-21T00:00:00.000Z',
  providerDeliveryId: 'provider',
  requestBytes: [0, 255],
  headers: { 'content-type': 'application/json' },
};

function snapshot(collection: string, id: string, value: unknown): Snapshot {
  return { rows: new Map([[collection, new Map([[id, value]])]]), events: [] };
}

Deno.test('core format accepts pending and interrupted attempts without modifying persisted values', () => {
  for (
    const value of [attempt, {
      ...attempt,
      completedAt: '2026-09-21T00:00:01.000Z',
      errorCode: 'INTERRUPTED',
      outcome: 'unknown',
    }, {
      ...attempt,
      completedAt: '2026-09-21T00:00:01.000Z',
      responseStatus: 200,
      responseBytes: [0, 255],
      responseTruncated: false,
    }]
  ) {
    const state = snapshot('emulon.attempts', 'attempt', value);
    const before = JSON.stringify(value);

    validateCoreFormat(state);

    if (JSON.stringify(value) !== before) {
      throw new Error('Validation mutated state');
    }
  }

  const custom = new Map();

  custom.set(custom, custom);
  validateCoreFormat(snapshot('plugin.custom', 'opaque', custom));
});

Deno.test('core format rejects malformed attempt fields, mismatched row identity and invalid delivery deadlines without leaking values', () => {
  const invalid = [
    ...[
      { id: 'wrong' },
      { deliveryId: undefined },
      { startedAt: 'not-a-date' },
      { completedAt: 1 },
      { responseStatus: 0 },
      { errorCode: 1 },
      { outcome: 'success' },
      { providerDeliveryId: undefined },
      { requestBytes: [256] },
      { requestBytes: [-1] },
      { requestBytes: [1.5] },
      { headers: { authorization: { secret: 'private-secret' } } },
      { responseBytes: 'private-secret' },
      { responseTruncated: 'yes' },
    ].map((fields) =>
      snapshot('emulon.attempts', 'attempt', { ...attempt, ...fields })
    ),
    snapshot('emulon.deliveries', 'delivery', {
      id: 'delivery',
      eventId: 'event',
      destinationId: 'receiver',
      status: 'queued',
      nextAttemptAt: 'private-secret',
    }),
  ];

  for (const state of invalid) {
    let rejected = false;

    try {
      validateCoreFormat(state);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Invalid core state record format.'
      ) {
        throw error;
      }

      rejected = true;
    }

    if (!rejected) {
      throw new Error('Malformed core state accepted');
    }
  }
});
