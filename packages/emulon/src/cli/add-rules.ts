import ts from 'typescript';
import { CommandError } from '../commands/registry.ts';
import { isRecord } from '../plugins/validation.ts';

export type Manager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'deno';

export function packageManager(files: readonly string[]): Manager {
  const locks: Record<Manager, string[]> = {
    npm: ['package-lock.json', 'npm-shrinkwrap.json'],
    pnpm: ['pnpm-lock.yaml'],
    yarn: ['yarn.lock'],
    bun: ['bun.lock', 'bun.lockb'],
    deno: ['deno.lock'],
  };
  const found = (Object.keys(locks) as Manager[]).filter((manager) =>
    locks[manager].some((file) => files.includes(file))
  );

  if (found.length > 1) {
    throw new CommandError(
      'PACKAGE_MANAGER_AMBIGUOUS',
      'Multiple package manager lockfiles found.',
    );
  }

  return found[0] ??
    (files.includes('package.json')
      ? 'npm'
      : files.some((file) => file === 'deno.json' || file === 'deno.jsonc')
      ? 'deno'
      : 'npm');
}

export function installArguments(
  manager: Manager,
  packages: readonly string[],
): string[] {
  if (manager === 'npm') {
    return ['install', '--save-dev', '--', ...packages];
  }

  if (manager === 'pnpm') {
    return ['add', '--save-dev', '--', ...packages];
  }

  if (manager === 'deno') {
    return [
      'add',
      '--node-modules-dir=auto',
      ...packages.map((name) => `npm:${name}`),
    ];
  }

  return ['add', '--dev', '--', ...packages];
}

export function validateMetadata(value: unknown, name: string): void {
  if (!isRecord(value) || value.name !== name || !isRecord(value.emulon)) {
    throw new CommandError(
      'PLUGIN_INVALID',
      `${name} has no valid Emulon plugin metadata.`,
    );
  }

  if (value.emulon.apiVersion !== 1) {
    throw new CommandError(
      'PLUGIN_INCOMPATIBLE',
      `${name} requires emulon.apiVersion 1.`,
    );
  }
}

export interface Addition {
  package: string;
  instance: string;
  import: string;
  service: string;
}

/** Plan insertions only; never execute project code or reprint existing nodes. */
export function editConfig(source: string, packages: readonly string[]) {
  const file = ts.createSourceFile(
    'emulon.config.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics =
    ts.transpileModule(source, { reportDiagnostics: true }).diagnostics;
  const identifiers = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) {
      identifiers.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);

  const fresh = (base: string) => {
    let name = base;

    for (let i = 2; identifiers.has(name); i++) {
      name = `${base}${i}`;
    }

    identifiers.add(name);

    return name;
  };

  const imports = new Map<string, string>();
  let define: string | undefined;
  let safe = !diagnostics?.length && !source.startsWith('#!');
  const exports: ts.ExportAssignment[] = [];

  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;

      if (!clause || clause.isTypeOnly) {
        safe = false;

        continue;
      }

      const name = statement.moduleSpecifier.text.replace(/^npm:/, '').replace(
        /@[^/@]+$/,
        '',
      );

      if (clause.name) {
        imports.set(clause.name.text, name);
      }

      if (
        name === 'emulon' && clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const binding of clause.namedBindings.elements) {
          if (
            !binding.isTypeOnly &&
            (binding.propertyName ?? binding.name).text === 'defineConfig'
          ) {
            define = binding.name.text;
          }
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exports.push(statement);
    } else {
      safe = false;
    }
  }

  const expression = exports.length === 1 ? exports[0]!.expression : undefined;
  const object = expression && ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === define &&
      expression.arguments.length === 1 &&
      ts.isObjectLiteralExpression(expression.arguments[0]!)
    ? expression.arguments[0] as ts.ObjectLiteralExpression
    : undefined;
  const property = object?.properties.length === 1
    ? object.properties[0]
    : undefined;
  const services = property && ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === 'services' &&
      ts.isObjectLiteralExpression(property.initializer)
    ? property.initializer
    : undefined;

  safe &&= !!services;

  const configured = new Set<string>();
  const keys = new Set<string>();

  for (const service of services?.properties ?? []) {
    if (
      !ts.isPropertyAssignment(service) ||
      !(ts.isIdentifier(service.name) || ts.isStringLiteral(service.name)) ||
      keys.has(service.name.text) ||
      !ts.isCallExpression(service.initializer) ||
      !ts.isIdentifier(service.initializer.expression) ||
      !imports.has(service.initializer.expression.text)
    ) {
      safe = false;

      continue;
    }

    keys.add(service.name.text);
    configured.add(imports.get(service.initializer.expression.text)!);
  }

  const additions: Addition[] = [];

  for (const name of new Set(packages)) {
    if (safe && configured.has(name)) {
      continue;
    }

    const binding = fresh('emulonPlugin');
    const base = name.split('/').at(-1)!.replace(/^emulon-plugin-/, '');
    const instance = fresh(
      [
          'init',
          'add',
          'up',
          'down',
          'status',
          'events',
          'clock',
          'reset',
          'exec',
          // A literal __proto__ property changes the prototype, not own services.
          '__proto__',
        ].includes(base)
        ? `${base}Service`
        : base,
    );

    additions.push({
      package: name,
      instance,
      import: `import ${binding} from ${JSON.stringify(name)};`,
      service: `${
        /^[A-Za-z_$][\w$]*$/.test(instance)
          ? instance
          : JSON.stringify(instance)
      }: ${binding}(),`,
    });
  }

  let updated = source;

  if (safe && additions.length && services) {
    const position = services.getStart(file) + 1;
    const line = source.slice(0, property!.getStart(file)).split('\n').at(-1)!;
    const indent = line.match(/^\s*/)?.[0] ?? '';
    const remainder = source.slice(position, services.end - 1);
    const tail = remainder === ''
      ? `\n${indent}` + source.slice(services.end - 1)
      : (remainder.startsWith('\n') ? '' : '\n') + source.slice(position);

    updated = additions.map((entry) => entry.import).join('\n') + '\n' +
      source.slice(0, position) + '\n' + additions.map((entry) =>
        `${indent}  ${entry.service}`
      ).join('\n') + tail;
  }

  return { safe, source: updated, additions };
}
