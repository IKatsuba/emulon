// Async methods preserve the rejection contract of future I/O-backed adapters.
// deno-lint-ignore-file require-await
import { cloneState } from './clone.ts';

export interface Entity {
  collection: string;
  id: string;
  value: unknown;
}

export interface StateVersion {
  pluginVersion: string;
  schemaVersion: number;
}

export interface EventRecord {
  id: string;
  instanceId: string;
  type: string;
  occurredAt: string;
  origin: 'service' | 'published' | 'direct';
  payload: unknown;
}

export interface Transaction {
  get(collection: string, id: string): Promise<unknown>;
  list(collection: string): Promise<Entity[]>;
  put(entity: Entity): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  record(event: Omit<EventRecord, 'id' | 'instanceId'>): Promise<EventRecord>;
  outbox(): Promise<EventRecord[]>;
}

export interface Store {
  readonly generation: number;
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Capture before starting asynchronous work that may span a reset. */
  scope(): Store;
  /** Observe committed writes and lifecycle changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Only the host receives lifecycle operations or chooses an adapter. */
export interface StateHandle {
  readonly version: StateVersion;
  readonly store: Store;
  reset(): Promise<void>;
  close(): void;
}

export interface StateAdapter {
  open(input: {
    environmentId: string;
    instanceId: string;
    version: StateVersion;
    fixtures: readonly Entity[];
    onEvent?: (event: EventRecord) => void;
  }): Promise<StateHandle>;
}

export function checkVersion(
  required: StateVersion,
  actual: StateVersion,
): void {
  if (
    required.pluginVersion !== actual.pluginVersion ||
    required.schemaVersion !== actual.schemaVersion
  ) {
    throw new Error(
      `State version mismatch: required plugin ${required.pluginVersion}, schema ${required.schemaVersion}; actual plugin ${actual.pluginVersion}, schema ${actual.schemaVersion}.`,
    );
  }
}

export interface Snapshot {
  rows: Map<string, Map<string, unknown>>;
  events: EventRecord[];
}
export interface Persistence {
  snapshot: Snapshot;
  generation: number;
  revision: number;
  commit(snapshot: Snapshot, generation: number, revision: number): void;
  reset(): Promise<void>;
}
export type OpenState = Parameters<StateAdapter['open']>[0];
export interface ManagedState extends StateHandle {
  notify(): void;
  replace(snapshot: Snapshot, generation: number, revision: number): void;
}

export function stateHandle(
  { instanceId, version, fixtures, onEvent }: OpenState,
  persistence?: Persistence,
): ManagedState {
  const initial = cloneState(fixtures);

  function seed() {
    const rows = new Map<string, Map<string, unknown>>();

    for (const row of initial) {
      let collection = rows.get(row.collection);

      if (!collection) {
        rows.set(row.collection, collection = new Map());
      }

      collection.set(row.id, cloneState(row.value));
    }

    return rows;
  }

  let rows = persistence?.snapshot.rows ?? seed();
  let events: EventRecord[] = persistence?.snapshot.events ?? [];
  let generation = persistence?.generation ?? 0;
  let revision = persistence?.revision ?? 0;
  let closed = false;
  let tail = Promise.resolve();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch { /* Observers cannot undo a committed write. */ }
    }
  };

  function store(expected?: number): Store {
    return Object.freeze({
      get generation() {
        return expected ?? generation;
      },
      scope: () => store(expected ?? generation),
      subscribe(listener: () => void) {
        listeners.add(listener);

        return () => {
          listeners.delete(listener);
        };
      },
      transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
        const started = expected ?? generation;
        const guard = () => {
          if (closed) {
            throw new Error('State store is closed.');
          }

          if (started !== generation) {
            throw new Error('Stale state generation.');
          }
        };

        const result = tail.then(async () => {
          guard();

          const draft = cloneState(rows);
          const outbox = cloneState(events);
          let active = true;
          let changed = false;
          const check = () => {
            guard();

            if (!active) {
              throw new Error('Transaction is finished.');
            }
          };

          const tx: Transaction = Object.freeze({
            async get(collection: string, id: string) {
              check();

              return cloneState(draft.get(collection)?.get(id));
            },
            async list(collection: string) {
              check();

              return [...(draft.get(collection) ?? [])].map((
                [id, value],
              ) => ({ collection, id, value: cloneState(value) }));
            },
            async put(entity: Entity) {
              check();

              changed = true;

              let collection = draft.get(entity.collection);

              if (!collection) {
                draft.set(entity.collection, collection = new Map());
              }

              collection.set(entity.id, cloneState(entity.value));
            },
            async delete(collection: string, id: string) {
              check();

              changed = draft.get(collection)?.delete(id) || changed;
            },
            async record(event: Omit<EventRecord, 'id' | 'instanceId'>) {
              check();

              const record: EventRecord = {
                ...cloneState(event),
                id: crypto.randomUUID(),
                instanceId,
              };

              changed = true;

              outbox.push(record);

              return cloneState(record);
            },
            async outbox() {
              check();

              return cloneState(outbox);
            },
          });

          try {
            const value = await work(tx);

            check();

            active = false;

            if (changed) {
              persistence?.commit(
                { rows: draft, events: outbox },
                generation,
                revision,
              );
              revision++;
            }

            rows = draft;

            const added = outbox.slice(events.length);

            events = outbox;

            for (const event of added) {
              try {
                onEvent?.(cloneState(event));
              } catch { /* Observers cannot undo a commit. */ }
            }

            if (changed) {
              notify();
            }

            return value;
          } finally {
            active = false;
          }
        });

        tail = result.then(() => {}, () => {});

        return result;
      },
    });
  }

  return {
    version: Object.freeze({ ...version }),
    store: store(),
    reset() {
      if (closed) {
        return Promise.reject(new Error('State store is closed.'));
      }

      if (persistence) {
        return persistence.reset();
      }

      const restored = seed();

      generation++;

      rows = restored;
      events = [];

      notify();

      // Old callbacks may finish later; their generation cannot commit.
      tail = Promise.resolve();

      return Promise.resolve();
    },
    replace(snapshot: Snapshot, nextGeneration: number, nextRevision: number) {
      rows = snapshot.rows;
      events = snapshot.events;
      generation = nextGeneration;
      revision = nextRevision;
      tail = Promise.resolve();
    },
    notify,
    close() {
      closed = true;

      notify();
    },
  };
}

export function memoryAdapter(): StateAdapter {
  return { open: (input) => Promise.resolve(stateHandle(input)) };
}
