import { z } from 'zod';
import {
  type Destination,
  destinationSchema,
  type PluginContext,
} from 'emulon';
import { type Interval, isFree } from './intervals.ts';

export class CalError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

// Round-tripping the calendar date rejects JavaScript's rollover of February 30.
export function utcInstant(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return NaN;
  }

  const time = Date.parse(value);

  return Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
    ? time
    : NaN;
}

export function queryBound(value: string, end: boolean): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = utcInstant(value + 'T00:00:00Z');

    return time + (end ? 86400000 - 1 : 0);
  }

  return utcInstant(value);
}

export const instant = z.string().refine(
  (v) => Number.isFinite(utcInstant(v)),
  'Expected a valid UTC timestamp.',
);
const bound = z.string().refine(
  (v) => Number.isFinite(queryBound(v, false)),
  'Expected a UTC date or timestamp.',
);
export const idSchema = z.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
);
const createShape = z.strictObject({
  title: z.string().min(1),
  slug: z.string().min(1),
  lengthInMinutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  slots: z.array(instant).refine(
    (v) => new Set(v.map(utcInstant)).size === v.length,
    'Slots must be unique.',
  ),
});

export interface CreateInput {
  title: string;
  slug: string;
  lengthInMinutes: number;
  slots: string[];
}

export const createInput: z.ZodType<CreateInput, CreateInput> = createShape;
export const eventTypeSchema: z.ZodType<EventType, EventType> = createShape
  .omit({ slots: true }).extend({
    id: idSchema,
  });

export interface EventType {
  id: number;
  title: string;
  slug: string;
  lengthInMinutes: number;
}

export const storedSchema = createShape.extend({ id: idSchema });
export const queryInput: z.ZodType<SlotQuery, SlotQuery> = z.strictObject({
  eventTypeId: idSchema,
  start: bound,
  end: bound,
  timeZone: z.literal('UTC').optional(),
}).refine(
  (v) => queryBound(v.start, false) <= queryBound(v.end, true),
  'Start must not exceed end.',
);

export interface SlotQuery {
  eventTypeId: number;
  start: string;
  end: string;
  timeZone?: 'UTC' | undefined;
}

export const slotsSchema: z.ZodType<Slots, Slots> = z.record(
  z.string(),
  z.array(z.strictObject({ start: z.string() })),
);

export type Slots = Record<string, { start: string }[]>;
export interface Organizer {
  name: string;
  email: string;
  username: string;
}

export const organizerSchema: z.ZodType<Organizer, Organizer> = z.strictObject({
  name: z.string().min(1),
  email: z.email(),
  username: z.string().min(1),
});
const optionsSchema = z.strictObject({
  destinations: z.array(destinationSchema).optional(),
  fixtures: z.strictObject({
    organizer: organizerSchema.optional(),
    eventTypes: z.array(createShape.extend({ id: idSchema.optional() }))
      .optional(),
  }).optional(),
});

export interface Options {
  destinations?: Destination[] | undefined;
  fixtures?: {
    organizer?: { name: string; email: string; username: string } | undefined;
    eventTypes?: (CreateInput & { id?: number | undefined })[] | undefined;
  } | undefined;
}
type Store = PluginContext['store'];

function projection(value: z.infer<typeof storedSchema>): EventType {
  return {
    id: value.id,
    title: value.title,
    slug: value.slug,
    lengthInMinutes: value.lengthInMinutes,
  };
}

export function availableSlots(
  slots: readonly string[],
  query: SlotQuery,
  now: number,
  duration = 0,
  occupied: readonly Interval[] = [],
): Slots {
  const input = queryInput.parse(query);
  const start = queryBound(input.start, false);
  const end = queryBound(input.end, true);
  const result: Slots = {};

  for (const time of slots.map(utcInstant).sort((a, b) => a - b)) {
    if (time <= now || time < start || time > end) {
      continue;
    }

    if (!isFree({ start: time, end: time + duration * 60000 }, occupied)) {
      continue;
    }

    const value = new Date(time).toISOString();

    (result[value.slice(0, 10)] ??= []).push({ start: value });
  }

  return result;
}

export function createEventType(
  store: Store,
  raw: CreateInput,
): Promise<EventType> {
  const input = createInput.parse(raw);

  return store.transaction(async (tx) => {
    const rows = await tx.list('eventTypes');
    const id = idSchema.parse(
      rows.reduce(
        (max, row) => Math.max(max, storedSchema.parse(row.value).id),
        0,
      ) + 1,
    );
    const value = { ...input, id };

    await tx.put({ collection: 'eventTypes', id: String(id), value });

    return projection(value);
  });
}

export function getEventType(store: Store, id: number): Promise<EventType> {
  return store.transaction(async (tx) => {
    const value = await tx.get('eventTypes', String(idSchema.parse(id)));

    if (value === undefined) {
      throw new CalError(404, 'not_found', 'Event type not found.');
    }

    return projection(storedSchema.parse(value));
  });
}

export function listEventTypes(store: Store): Promise<EventType[]> {
  return store.transaction(async (tx) =>
    (await tx.list('eventTypes')).map((row) =>
      projection(storedSchema.parse(row.value))
    ).sort((a, b) => a.id - b.id)
  );
}

export function listSlots(
  store: Store,
  raw: SlotQuery,
  now: () => number,
): Promise<Slots> {
  const input = queryInput.parse(raw);

  return store.transaction(async (tx) => {
    const value = await tx.get('eventTypes', String(input.eventTypeId));

    if (value === undefined) {
      throw new CalError(404, 'not_found', 'Event type not found.');
    }

    const type = storedSchema.parse(value);
    const occupied = (await tx.list('bookings')).map((row) => {
      const booking = z.object({ start: instant, end: instant }).parse(
        row.value,
      );

      return { start: utcInstant(booking.start), end: utcInstant(booking.end) };
    });

    return availableSlots(
      type.slots,
      input,
      now(),
      type.lengthInMinutes,
      occupied,
    );
  });
}

export function fixtures(raw?: Options) {
  const options = optionsSchema.parse(raw ?? {});
  const ids = new Set<number>();
  const reserved = new Set(options.fixtures?.eventTypes?.map((v) => v.id));
  const types = (options.fixtures?.eventTypes ?? []).map(
    ({ id, ...input }) => {
      if (id === undefined) {
        id = 1;

        while (ids.has(id) || reserved.has(id)) {
          id++;
        }
      }

      if (ids.has(id)) {
        throw new Error('Duplicate event type fixture ID.');
      }

      ids.add(id);

      return {
        collection: 'eventTypes',
        id: String(id),
        value: { ...input, id },
      };
    },
  );

  return [...types, {
    collection: 'organizer',
    id: 'default',
    value: options.fixtures?.organizer ??
      {
        name: 'Local Organizer',
        email: 'organizer@example.test',
        username: 'local',
      },
  }];
}
