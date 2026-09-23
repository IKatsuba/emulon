import { resolvePluginName } from '../src/plugins/resolve.ts';

Deno.test('plugin names follow every documented resolution convention', () => {
  for (
    const [input, expected] of [
      ['github', '@emulon/github'],
      ['github@1.2.0', '@emulon/github@1.2.0'],
      ['community:acme', 'emulon-plugin-acme'],
      ['@team/acme', '@team/acme'],
      ['@emulon/github', '@emulon/github'],
      ['emulon-plugin-acme', 'emulon-plugin-acme'],
      ['acme', '@emulon/acme'],
      ['unknown-service', '@emulon/unknown-service'],
      ['community:acme@1.2.0', 'emulon-plugin-acme@1.2.0'],
      ['@team/acme@1.2.0', '@team/acme@1.2.0'],
    ] as const
  ) {
    const actual = resolvePluginName(input);

    if (actual !== expected) {
      throw new Error(`${input}: expected ${expected}, received ${actual}`);
    }
  }
});

Deno.test('malformed plugin names fail without a community fallback', () => {
  for (
    const input of [
      '',
      ' github',
      'github ',
      'community:',
      '@team/',
      '@team',
      'github@',
      'github@@1',
      'other:acme',
      './acme',
      'team/acme',
      '@team/acme/extra',
      'https://example.test/plugin',
      '../acme',
    ]
  ) {
    let rejected = false;

    try {
      resolvePluginName(input);
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }

      rejected = true;
    }

    if (!rejected) {
      throw new Error(`Expected rejection for ${input}`);
    }
  }
});
