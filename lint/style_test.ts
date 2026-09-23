import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import plugin from './style.ts';

function lint(source: string): string[] {
  return Deno.lint.runPlugin(plugin, 'main.ts', source)
    .map((d) => d.id.replace('style/', ''));
}

function fix(source: string): string {
  let result = source;
  const diagnostics = Deno.lint.runPlugin(plugin, 'main.ts', source)
    .flatMap((d) => d.fix ?? [])
    .sort((a, b) => b.range[0] - a.range[0]);

  for (const edit of diagnostics) {
    result = result.slice(0, edit.range[0]) + edit.text +
      result.slice(edit.range[1]);
  }

  return result;
}

Deno.test('imports-first reports an import after code', () => {
  assertEquals(
    lint("import a from './a.ts';\n\nfoo();\nimport b from './b.ts';\n"),
    ['imports-first'],
  );
});

Deno.test('blank-after-imports inserts the missing line', () => {
  assertEquals(
    fix("import a from './a.ts';\nfoo(a);\n"),
    "import a from './a.ts';\n\nfoo(a);\n",
  );
  assertEquals(lint("import a from './a.ts';\n\nfoo(a);\n"), []);
});

Deno.test('blank-before-exit skips a leading return and keeps comments', () => {
  assertEquals(lint('function f() {\n  return 1;\n}\n'), []);
  assertEquals(
    fix('function f() {\n  g();\n  // why\n  return 1;\n}\n'),
    'function f() {\n  g();\n\n  // why\n  return 1;\n}\n',
  );
});

Deno.test('blank-before-exit applies inside switch cases', () => {
  assertEquals(
    lint(
      'function f(x: number) {\n  switch (x) {\n    case 1:\n      g();\n      return 1;\n  }\n}\n',
    ),
    ['blank-before-exit'],
  );
});

Deno.test('blank-before-declaration groups only consecutive variables', () => {
  assertEquals(lint('const a = 1;\nlet b = 2;\n'), []);
  assertEquals(
    fix('function f() {}\nconst a = 1;\nfunction g() {}\n'),
    'function f() {}\n\nconst a = 1;\n\nfunction g() {}\n',
  );
  assertEquals(
    fix('g();\nconst a = 1;\nconst b = 2;\n'),
    'g();\n\nconst a = 1;\nconst b = 2;\n',
  );
});

Deno.test('blank-before-declaration covers exports and ignores loop headers', () => {
  assertEquals(lint('g();\nexport const a = 1;\n'), [
    'blank-before-declaration',
  ]);
  assertEquals(lint('for (let i = 0; i < 1; i++) {\n  g(i);\n}\n'), []);
});

Deno.test('blank-before-control-flow covers loops, switch, try and if', () => {
  assertEquals(
    fix('g();\nfor (const x of y) {\n  h(x);\n}\n'),
    'g();\n\nfor (const x of y) {\n  h(x);\n}\n',
  );
  assertEquals(
    lint(
      'g();\nswitch (x) {\n}\ng();\ntry {\n  h();\n} catch {\n  i();\n}\ng();\nif (x) {\n  h();\n}\n',
    ).filter((id) => id === 'blank-before-control-flow'),
    [
      'blank-before-control-flow',
      'blank-before-control-flow',
      'blank-before-control-flow',
    ],
  );
});

Deno.test('blank-before-control-flow skips first statements and else-if', () => {
  assertEquals(
    lint(
      'function f(x: number) {\n  if (x) {\n    g();\n  } else if (x > 1) {\n    h();\n  }\n}\n',
    ),
    [],
  );
});

Deno.test('blank-before-exit treats throw like return', () => {
  assertEquals(lint('function f() {\n  throw new Error();\n}\n'), []);
  assertEquals(
    fix('function f() {\n  g();\n  throw new Error();\n}\n'),
    'function f() {\n  g();\n\n  throw new Error();\n}\n',
  );
});

Deno.test('blank-after-declaration separates a variable block from code', () => {
  assertEquals(
    fix('function f() {\n  const a = 1;\n  g(a);\n}\n'),
    'function f() {\n  const a = 1;\n\n  g(a);\n}\n',
  );
  assertEquals(lint('function f() {\n  const a = 1;\n  const b = 2;\n}\n'), []);
});

Deno.test('blank-after-block follows closing braces of blocks only', () => {
  assertEquals(
    fix('function f(x: boolean) {\n  if (x) {\n    g();\n  }\n  h();\n}\n'),
    'function f(x: boolean) {\n  if (x) {\n    g();\n  }\n\n  h();\n}\n',
  );
  assertEquals(
    fix('o.m = function () {\n  g();\n};\nh();\n'),
    'o.m = function () {\n  g();\n};\n\nh();\n',
  );
  assertEquals(lint('g({\n  a: 1,\n});\nh();\n'), []);
  assertEquals(lint('const f = () => {\n  g();\n};\nh();\n'), [
    'blank-after-declaration',
  ]);
});

Deno.test('blank-after-block counts callback-style calls as blocks', () => {
  assertEquals(
    fix("test('a', () => {\n  g();\n});\ntest('b', () => {});\n"),
    "test('a', () => {\n  g();\n});\n\ntest('b', () => {});\n",
  );
  assertEquals(lint('g({\n  a: 1,\n});\nh();\n'), []);
});

Deno.test('blank-around-assignment groups consecutive assignments', () => {
  assertEquals(
    fix('function f() {\n  g();\n  a = 1;\n  b.c = 2;\n  h();\n}\n'),
    'function f() {\n  g();\n\n  a = 1;\n  b.c = 2;\n\n  h();\n}\n',
  );
});
