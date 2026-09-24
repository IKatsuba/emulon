import { invalidRequest } from '../errors.ts';
import type { Fields } from '../http/fields.ts';
import type { Kind, Page, Resolver, ResourceRecord } from '../model/core.ts';

/** `expand[]` paths, at most four properties deep as Stripe allows. */
export function readExpand(fields: Fields): string[] {
  const paths = fields.expand();

  for (const path of paths) {
    if (path.split('.').length > 4) {
      throw invalidRequest(
        `You cannot expand more than 4 levels of a property: ${path}.`,
        'expand',
      );
    }
  }

  return paths;
}

/** `limit` (1-100, default 10) and one of `starting_after`/`ending_before`. */
export function readPage(fields: Fields): Page {
  const limit = fields.int('limit', { min: 1, max: 100 }) ?? 10;
  const startingAfter = fields.string('starting_after');
  const endingBefore = fields.string('ending_before');

  if (startingAfter && endingBefore) {
    throw invalidRequest(
      'You may only specify one of these parameters: starting_after, ending_before.',
    );
  }

  return { limit, startingAfter, endingBefore };
}

/**
 * Replace ID strings with projected objects along `expand[]` paths such as
 * `promotion.coupon` or `data.promotion.coupon`. `expandable` names the
 * properties that refer to another resource in one version's objects; other
 * paths are rejected like Stripe does, instead of being ignored.
 */
export async function expandPaths(
  value: unknown,
  paths: readonly string[],
  expandable: Readonly<Record<string, Kind>>,
  resolve: Resolver,
  project: (record: ResourceRecord) => unknown,
): Promise<unknown> {
  for (const path of paths) {
    await expandPath(value, path.split('.'), path);
  }

  return value;

  async function expandPath(
    node: unknown,
    path: string[],
    full: string,
  ): Promise<void> {
    const [head, ...rest] = path;

    if (head === undefined || node === null || typeof node !== 'object') {
      return;
    }

    const record = node as Record<string, unknown>;

    if (head === 'data' && Array.isArray(record.data)) {
      for (const item of record.data) {
        await expandPath(item, rest, full);
      }

      return;
    }

    if (!Object.hasOwn(record, head)) {
      throw invalidRequest(
        `This property cannot be expanded (${full}).`,
        'expand',
      );
    }

    if (rest.length > 0) {
      await expandPath(record[head], rest, full);

      return;
    }

    const kind = Object.hasOwn(expandable, head) ? expandable[head] : undefined;
    const current = record[head];

    if (kind === undefined) {
      throw invalidRequest(
        `This property cannot be expanded (${full}).`,
        'expand',
      );
    }

    if (typeof current === 'string') {
      const found = await resolve(kind, current);

      record[head] = found === undefined ? current : project(found);
    }
  }
}
