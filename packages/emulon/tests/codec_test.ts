import { decodeGraph, encodeGraph } from '../src/state/codec.ts';
import { cloneState } from '../src/state/clone.ts';

function assert(v: unknown): asserts v {
  if (!v) {
    throw new Error('Assertion failed');
  }
}

Deno.test('graph codec round trips cloneState kinds, cycles, sparse keys and shared backing buffers', () => {
  const buffer = new ArrayBuffer(64);
  const sparse = new Array(7);

  sparse[3] = undefined;

  Object.defineProperty(sparse, '4294967295', {
    value: 'not an array index',
    enumerable: true,
  });
  Object.defineProperty(sparse, '__proto__', {
    value: 'safe',
    enumerable: true,
  });

  const value = {
    primitives: [
      null,
      undefined,
      true,
      false,
      '',
      10n,
      -999n,
      NaN,
      Infinity,
      -Infinity,
      -0,
    ],
    sparse,
    dates: [new Date(NaN), new Date(0)],
    regex: /x/giu,
    errors: [
      new Error('e'),
      new EvalError('e'),
      new RangeError('e'),
      new ReferenceError('e'),
      new SyntaxError('e'),
      new TypeError('e'),
      new URIError('e'),
    ],
    buffer,
    views: [
      new Int8Array(buffer, 8, 3),
      new Uint8Array(buffer, 8, 3),
      new Uint8ClampedArray(buffer, 8, 3),
      new Int16Array(buffer, 8, 3),
      new Uint16Array(buffer, 8, 3),
      new Int32Array(buffer, 8, 3),
      new Uint32Array(buffer, 8, 3),
      new Float32Array(buffer, 8, 3),
      new Float64Array(buffer, 8, 3),
      new BigInt64Array(buffer, 8, 3),
      new BigUint64Array(buffer, 8, 3),
      new DataView(buffer, 3, 17),
    ],
    map: new Map<unknown, unknown>(),
    set: new Set<unknown>(),
  };

  value.errors[0]!.cause = value;

  value.map.set(value, sparse);
  value.map.set('second', buffer);
  value.set.add(value);
  value.set.add(sparse);

  new Uint8Array(buffer)[8] = 42;

  const copy = decodeGraph(encodeGraph(value)) as typeof value;

  assert(
    copy !== value && copy.map.get(copy) === copy.sparse &&
      [...copy.map.keys()][1] === 'second' && [...copy.set][0] === copy &&
      copy.errors[0]!.cause === copy,
  );
  assert(
    copy.sparse.length === 7 && !(0 in copy.sparse) && 3 in copy.sparse &&
      Object.hasOwn(copy.sparse, '__proto__') &&
      Object.getPrototypeOf(copy.sparse) === Array.prototype,
  );
  copy.primitives.forEach((p, i) => assert(Object.is(p, value.primitives[i])));
  assert(
    Number.isNaN(copy.dates[0]!.getTime()) && copy.dates[1]!.getTime() === 0 &&
      copy.regex.source === 'x' && copy.regex.flags === 'giu',
  );
  copy.views.forEach((v, i) => {
    const original = value.views[i]!;

    assert(
      v.buffer === copy.buffer && v.byteOffset === original.byteOffset &&
        v.byteLength === original.byteLength &&
        v.constructor === original.constructor,
    );
  });

  copy.errors.forEach((e, i) =>
    assert(
      e.name === value.errors[i]!.name && e.message === 'e' &&
        e.stack === cloneState(value.errors[i]!).stack,
    )
  );
  assert(new Uint8Array(copy.buffer)[8] === 42);
  assert(Reflect.get(copy.sparse, '4294967295') === 'not an array index');

  for (
    const rejected of [
      () => {},
      new SharedArrayBuffer(8),
      new Uint8Array(new SharedArrayBuffer(8)),
    ]
  ) {
    let failed = false;

    try {
      encodeGraph(rejected);
    } catch {
      failed = true;
    }

    assert(failed);
  }
});

Deno.test('graph decoder rejects malformed envelopes without resolving data-named constructors', () => {
  const cases: unknown[] = [
    null,
    {},
    [2, ['null'], []],
    [1, ['ref', 0], []],
    [1, ['number', '01'], []],
    [1, ['bigint', '01'], []],
    [1, ['boolean', 1], []],
    [1, ['null', 1], []],
    [1, ['ref', 0], [['Function', 'return 1']]],
    [1, ['ref', 0], [['object', [['x', ['null']], ['x', ['null']]]]]],
    [1, ['ref', 0], [['array', 2, [['length', ['number', '1']]]]]],
    [1, ['ref', 0], [['array', 2, [['2', ['null']]]]]],
    [1, ['ref', 0], [['view', 'Uint16Array', ['ref', 1], 1, 2], ['buffer', [
      0,
      1,
      2,
      3,
    ]]]],
    [1, ['ref', 0], [['view', 'DataView', ['ref', 1], 0, 5], ['buffer', [0]]]],
    [1, ['ref', 0], [['view', 'constructor', ['ref', 1], 0, 0], [
      'buffer',
      [],
    ]]],
    [1, ['ref', 0], [['buffer', [256]]]],
    [1, ['null'], [['object', [['bad', ['ref', 9]]]]]],
    [1, ['ref', 0], [['error', 'Error', [['__proto__', ['null']]]]]],
  ];

  // Keep the malformed offsets and bytes inside otherwise well-shaped nodes.
  for (const envelope of cases) {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[2])) {
      continue;
    }

    for (const node of envelope[2]) {
      if (node[0] === 'buffer') {
        node.push(null);
      }

      if (node[0] === 'view') {
        node.push(false);
      }
    }
  }

  for (const value of cases) {
    let failed = false;

    try {
      decodeGraph(new TextEncoder().encode(JSON.stringify(value)));
    } catch (e) {
      failed = e instanceof Error &&
        e.message === 'Invalid or unsupported state graph.';
    }

    assert(failed);
  }
});

Deno.test('graph codec retains resizable buffers and fixed versus length-tracking views', () => {
  const buffer = new ArrayBuffer(16, { maxByteLength: 32 });
  const value = {
    buffer,
    fixed: new Uint16Array(buffer, 4, 4),
    tracking: new Uint16Array(buffer, 4),
    data: new DataView(buffer, 3),
    fixedData: new DataView(buffer, 3, 4),
  };
  const copy = decodeGraph(encodeGraph(value)) as typeof value;

  assert(copy.buffer.resizable && copy.buffer.maxByteLength === 32);
  copy.buffer.resize(32);
  assert(
    copy.fixed.length === 4 && copy.tracking.length === 14 &&
      copy.data.byteLength === 29 && copy.fixedData.byteLength === 4,
  );

  const half =
    (globalThis as unknown as { Float16Array?: Float32ArrayConstructor })
      .Float16Array;

  if (half) {
    const v = new half([1, 2]);
    const result = decodeGraph(encodeGraph(v)) as Float32Array;

    assert(result.constructor === half && result[1] === 2);
  }
});
