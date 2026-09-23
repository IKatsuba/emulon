import { withoutTypeStrippingNotice } from '../../../scripts/runtime-warnings.ts';

Deno.test('archive warning checks exempt only the explicit Type Stripping notice', () => {
  const trace =
    '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  const notice = (feature: string) =>
    `(node:123) ExperimentalWarning: ${feature} is an experimental feature and might change at any time\n`;
  const other = notice('SQLite') + trace + 'Application error\n';

  for (
    const prefix of [notice('Type Stripping'), notice('Type Stripping') + trace]
  ) {
    if (withoutTypeStrippingNotice(prefix + other) !== other) {
      throw new Error(
        'Verifier removed an unrelated warning or application output',
      );
    }
  }

  if (withoutTypeStrippingNotice(other) !== other) {
    throw new Error('Verifier accepted a SQLite warning');
  }
});
