import { StripeError } from '../errors.ts';

/** A decoded Stripe parameter tree: form and query values are always strings. */
export type Params = { [key: string]: Param };
export type Param = string | Param[] | Params;

function invalid(param: string, message: string): StripeError {
  return new StripeError(400, 'invalid_request_error', message, {
    param,
  });
}

/** Split `a[b][0]` into `['a', 'b', '0']`; `a[]` appends. */
export function keyPath(key: string): string[] {
  const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);

  if (!match) {
    throw invalid(key, `Invalid parameter name: ${key}.`);
  }

  const path = [
    match[1]!,
    ...[...match[2]!.matchAll(/\[([^[\]]*)\]/g)].map((part) => part[1]!),
  ];

  // Parameter names become object keys; never let one reach a prototype.
  if (
    path.some((part) =>
      ['__proto__', 'constructor', 'prototype'].includes(part)
    )
  ) {
    throw invalid(key, `Invalid parameter name: ${key}.`);
  }

  return path;
}

/**
 * Decode Stripe's bracket encoding as the official clients send it: nested
 * objects as `a[b]=`, arrays as `a[0]=` or `a[]=`. A repeated scalar is
 * rejected instead of silently choosing one value.
 */
export function decodeParams(pairs: Iterable<[string, string]>): Params {
  const root: Params = {};

  for (const [key, value] of pairs) {
    const path = keyPath(key);
    let node: Params | Param[] = root;

    for (let i = 0; i < path.length; i++) {
      const part = path[i]!;
      const last = i === path.length - 1;
      const nextIsIndex = !last && /^\d*$/.test(path[i + 1]!);

      if (Array.isArray(node)) {
        if (part !== '' && !/^\d+$/.test(part)) {
          throw invalid(key, `Invalid array index in ${key}.`);
        }

        const index = part === '' ? node.length : Number(part);

        if (index > node.length || index > 1000) {
          throw invalid(key, `Array indices in ${key} must be sequential.`);
        }

        if (last) {
          if (node[index] !== undefined) {
            throw invalid(key, `Duplicate parameter: ${key}.`);
          }

          node[index] = value;
        } else {
          node[index] ??= nextIsIndex ? [] : {};
          node = container(node[index]!, key);
        }

        continue;
      }

      if (part === '') {
        throw invalid(key, `Invalid parameter name: ${key}.`);
      }

      if (last) {
        if (Object.hasOwn(node, part)) {
          throw invalid(key, `Duplicate parameter: ${key}.`);
        }

        node[part] = value;
      } else {
        if (!Object.hasOwn(node, part)) {
          node[part] = nextIsIndex ? [] : {};
        }

        node = container(node[part]!, key);
      }
    }
  }

  return root;
}

function container(value: Param, key: string): Params | Param[] {
  if (typeof value === 'string') {
    throw invalid(key, `Conflicting parameter: ${key}.`);
  }

  return value;
}

/** Read a parameter tree from a form body or a query string. */
export function parseParams(text: string): Params {
  return decodeParams(new URLSearchParams(text));
}
