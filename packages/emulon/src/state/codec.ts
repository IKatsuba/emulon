import { cloneState } from './clone.ts';

export const codecVersion = 1;
const views = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
  Float16Array:
    (globalThis as unknown as { Float16Array?: Float32ArrayConstructor })
      .Float16Array,
};
const errors = {
  Error,
  EvalError,
  RangeError,
  ReferenceError,
  SyntaxError,
  TypeError,
  URIError,
};

type ResizableBuffer = ArrayBuffer & {
  readonly resizable: boolean;
  readonly maxByteLength: number;
  resize(length: number): void;
};

function tracking(view: ArrayBufferView): boolean {
  const buffer = view.buffer as ResizableBuffer;

  if (!buffer.resizable) {
    return false;
  }

  const copy = structuredClone(view);
  const cloned = copy.buffer as ResizableBuffer;
  const size = view instanceof DataView
    ? 1
    : (view.constructor as unknown as { BYTES_PER_ELEMENT: number })
      .BYTES_PER_ELEMENT;

  if (view.byteLength > 0) {
    cloned.resize(view.byteOffset + view.byteLength - size);

    try {
      if (copy instanceof DataView) {
        return copy.byteLength >= 0;
      }

      // Iterating an out-of-bounds fixed view throws even when its length reads zero.
      (copy as unknown as Uint8Array).values().next();

      return true;
    } catch {
      return false;
    }
  }

  if (buffer.maxByteLength >= buffer.byteLength + size) {
    cloned.resize(buffer.byteLength + size);

    return copy.byteLength > 0;
  }

  // A zero-length view at maximum capacity has identical behavior either way.
  return false;
}

type Ref = unknown[];

/** Encode the normalized clone, never getters or application prototypes. */
export function encodeGraph(input: unknown): Uint8Array {
  const nodes: unknown[][] = [];
  const seen = new Map<object, number>();

  function ref(value: unknown): Ref {
    if (value === null) {
      return ['null'];
    }

    switch (typeof value) {
      case 'undefined':
        return ['undefined'];
      case 'boolean':
        return ['boolean', value];
      case 'string':
        return ['string', value];
      case 'bigint':
        return ['bigint', String(value)];
      case 'number':
        return ['number', Object.is(value, -0) ? '-0' : String(value)];
    }

    const object = value as object;

    if (seen.has(object)) {
      return ['ref', seen.get(object)];
    }

    const id = nodes.length;

    seen.set(object, id);

    const node: unknown[] = [];

    nodes.push(node);

    const props = () =>
      Object.getOwnPropertyNames(object).filter((k) =>
        !(Array.isArray(object) && k === 'length')
      ).map((k) => [k, ref(Reflect.get(object, k))]);

    if (Array.isArray(object)) {
      node.push('array', object.length, props());
    } else if (object instanceof Map) {
      node.push('map', [...object].map(([k, v]) => [ref(k), ref(v)]));
    } else if (object instanceof Set) {
      node.push('set', [...object].map(ref));
    } else if (object instanceof Date) {
      node.push('date', ref(object.getTime()));
    } else if (object instanceof RegExp) {
      node.push('regexp', object.source, object.flags);
    } else if (object instanceof ArrayBuffer) {
      node.push(
        'buffer',
        [...new Uint8Array(object)],
        (object as ResizableBuffer).resizable
          ? (object as ResizableBuffer).maxByteLength
          : null,
      );
    } else if (ArrayBuffer.isView(object)) {
      node.push(
        'view',
        object.constructor.name,
        ref(object.buffer),
        object.byteOffset,
        object.byteLength,
        tracking(object),
      );
    } else if (object instanceof Error) {
      node.push('error', object.name, props());
    } else {
      node.push('object', props());
    }

    return ['ref', id];
  }

  const root = ref(cloneState(input));

  return new TextEncoder().encode(JSON.stringify([codecVersion, root, nodes]));
}

/** Every tag, edge and property is checked before the graph leaves this boundary. */
export function decodeGraph(bytes: Uint8Array): unknown {
  try {
    return decode(bytes);
  } catch {
    throw new Error('Invalid or unsupported state graph.');
  }
}

function decode(bytes: Uint8Array): unknown {
  const fail = (): never => {
    throw new Error('Invalid graph');
  };

  const array = (x: unknown): unknown[] => Array.isArray(x) ? x : fail();
  const tuple = (x: unknown, length: number): unknown[] => {
    const a = array(x);

    if (a.length !== length) {
      fail();
    }

    return a;
  };

  const str = (x: unknown): string => typeof x === 'string' ? x : fail();
  const integer = (x: unknown): number =>
    typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : fail();
  const envelope = tuple(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    3,
  );

  if (envelope[0] !== codecVersion) {
    fail();
  }

  const nodes = array(envelope[2]).map(array);
  const objects: unknown[] = new Array(nodes.length);

  function ref(x: unknown): unknown {
    const a = array(x);

    if (a[0] === 'null' || a[0] === 'undefined') {
      tuple(a, 1);

      return a[0] === 'null' ? null : undefined;
    }

    tuple(a, 2);

    switch (a[0]) {
      case 'ref': {
        const id = integer(a[1]);

        if (id >= nodes.length) {
          fail();
        }

        return objects[id];
      }
      case 'string':
        return str(a[1]);
      case 'boolean':
        if (typeof a[1] !== 'boolean') {
          fail();
        }

        return a[1];
      case 'bigint': {
        const s = str(a[1]);

        if (!/^(0|-?[1-9][0-9]*)$/.test(s)) {
          fail();
        }

        return BigInt(s);
      }
      case 'number': {
        const s = str(a[1]);
        const n = Number(s);

        if (!(s === '-0' || String(n) === s)) {
          fail();
        }

        return n;
      }
      default:
        return fail();
    }
  }

  for (const [id, n] of nodes.entries()) {
    switch (n[0]) {
      case 'object':
        tuple(n, 2);

        objects[id] = {};

        break;
      case 'array':
        tuple(n, 3);

        objects[id] = new Array(integer(n[1]));

        break;
      case 'map':
        tuple(n, 2);

        objects[id] = new Map();

        break;
      case 'set':
        tuple(n, 2);

        objects[id] = new Set();

        break;
      case 'date': {
        tuple(n, 2);

        const time = ref(n[1]);

        if (typeof time !== 'number') {
          fail();
        }

        const date = new Date(time as number);

        if (!Object.is(date.getTime(), time)) {
          fail();
        }

        objects[id] = date;

        break;
      }
      case 'regexp':
        tuple(n, 3);

        objects[id] = new RegExp(str(n[1]), str(n[2]));

        break;
      case 'error': {
        tuple(n, 3);

        const name = str(n[1]);

        if (!Object.hasOwn(errors, name)) {
          fail();
        }

        const error = new errors[name as keyof typeof errors]();

        for (const key of Object.getOwnPropertyNames(error)) {
          Reflect.deleteProperty(error, key);
        }

        objects[id] = error;

        break;
      }
      case 'buffer': {
        tuple(n, 3);

        const data = array(n[1]).map((v) => {
          const b = integer(v);

          if (b > 255) {
            fail();
          }

          return b;
        });

        const max = n[2] === null ? undefined : integer(n[2]);

        if (max !== undefined && max < data.length) {
          fail();
        }

        const buffer = new (ArrayBuffer as unknown as new (
          length: number,
          options?: { maxByteLength: number },
        ) => ResizableBuffer)(
          data.length,
          max === undefined ? undefined : { maxByteLength: max },
        );

        if (
          max !== undefined &&
          (!buffer.resizable || buffer.maxByteLength !== max)
        ) {
          fail();
        }

        new Uint8Array(buffer).set(data);

        objects[id] = buffer;

        break;
      }
      case 'view':
        tuple(n, 6);
        break;
      default:
        fail();
    }
  }

  // Buffers exist before views, including forward references to a shared buffer.
  for (const [id, n] of nodes.entries()) {
    if (n[0] !== 'view') {
      continue;
    }

    const name = str(n[1]);

    if (!Object.hasOwn(views, name) || !views[name as keyof typeof views]) {
      fail();
    }

    const edge = tuple(n[2], 2);

    if (edge[0] !== 'ref') {
      fail();
    }

    const buffer = ref(edge);

    if (!(buffer instanceof ArrayBuffer)) {
      fail();
    }

    const offset = integer(n[3]);
    const length = integer(n[4]);
    const ctor = views[name as keyof typeof views]!;
    const size = 'BYTES_PER_ELEMENT' in ctor ? ctor.BYTES_PER_ELEMENT : 1;

    if (
      length % size || offset % size ||
      offset + length > (buffer as ArrayBuffer).byteLength
    ) {
      fail();
    }

    if (
      typeof n[5] !== 'boolean' ||
      (n[5] && !(buffer as ResizableBuffer).resizable)
    ) {
      fail();
    }

    objects[id] = new (ctor as new (
      buffer: ArrayBuffer,
      offset: number,
      length?: number,
    ) => ArrayBufferView)(
      buffer as ArrayBuffer,
      offset,
      n[5] ? undefined : name === 'DataView' ? length : length / size,
    );

    if ((objects[id] as ArrayBufferView).byteLength !== length) {
      fail();
    }
  }

  function properties(target: object, data: unknown, isError: boolean) {
    const keys = new Set<string>();

    for (const p of array(data)) {
      const [k, value] = tuple(p, 2);
      const key = str(k);

      if (
        keys.has(key) ||
        (Array.isArray(target) &&
          (key === 'length' ||
            (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 0xffffffff &&
              Number(key) >= target.length)))
      ) {
        fail();
      }

      if (isError && !['message', 'stack', 'cause'].includes(key)) {
        fail();
      }

      keys.add(key);
      Object.defineProperty(target, key, {
        value: ref(value),
        writable: true,
        configurable: true,
        enumerable: !isError,
      });
    }
  }

  for (const [id, n] of nodes.entries()) {
    const object = objects[id];

    if (n[0] === 'object' || n[0] === 'error' || n[0] === 'array') {
      properties(object as object, n[n.length - 1], n[0] === 'error');
    } else if (object instanceof Map) {
      for (const entry of array(n[1])) {
        const [k, v] = tuple(entry, 2);
        const key = ref(k);

        if (object.has(key)) {
          fail();
        }

        object.set(key, ref(v));
      }
    } else if (object instanceof Set) {
      for (const entry of array(n[1])) {
        const value = ref(entry);

        if (object.has(value)) {
          fail();
        }

        object.add(value);
      }
    }
  }

  return cloneState(ref(envelope[1]));
}
