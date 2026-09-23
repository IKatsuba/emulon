import { bodyLimit } from '../src/plugins/http-rules.ts';

Deno.test('body limits reject unsafe values and allow zero', () => {
  if (bodyLimit() !== 1048576 || bodyLimit(0) !== 0) {
    throw new Error('Wrong limit');
  }

  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    let rejected = false;

    try {
      bodyLimit(value);
    } catch {
      rejected = true;
    }

    if (!rejected) {
      throw new Error('Invalid limit accepted');
    }
  }
});
