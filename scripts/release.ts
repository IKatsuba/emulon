/**
 * Release helpers. All packages share one version, so a release bumps every
 * package together and a tag names that single version.
 *
 *   deno task release version <x.y.z>  bump packages and open the changelog
 *   deno task release verify <tag>     fail unless the tag matches packages
 *   deno task release notes <x.y.z>    print that version's changelog section
 */

const root = new URL('../', import.meta.url);
const packages = ['emulon', 'resend', 'github', 'stripe', 'calcom', 'polar'];
const cli = 'packages/emulon/src/cli/run.ts';
const changelog = 'CHANGELOG.md';
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

Deno.chdir(root);

const [command, argument] = Deno.args;

if (command === 'version' && argument && semver.test(argument)) {
  await bump(argument);
} else if (command === 'verify' && argument) {
  await verify(argument);
} else if (command === 'notes' && argument) {
  console.log(await notes(argument));
} else {
  console.error(
    'Usage: deno task release version <x.y.z> | verify <tag> | notes <x.y.z>',
  );
  Deno.exit(2);
}

async function bump(version: string): Promise<void> {
  for (const name of packages) {
    const path = `packages/${name}/deno.json`;
    const config = JSON.parse(await Deno.readTextFile(path));

    config.version = version;

    if (config.peerDependencies?.emulon) {
      config.peerDependencies.emulon = version;
    }

    await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + '\n');
  }

  const source = await Deno.readTextFile(cli);
  const updated = source.replace(
    /^const version = '[^']*';$/m,
    `const version = '${version}';`,
  );

  if (updated === source && !source.includes(`const version = '${version}';`)) {
    throw new Error(`Cannot find the CLI version constant in ${cli}`);
  }

  await Deno.writeTextFile(cli, updated);

  const log = await Deno.readTextFile(changelog);
  const date = new Date().toISOString().slice(0, 10);

  if (log.includes(`## [${version}]`)) {
    throw new Error(`${changelog} already has a ${version} section`);
  }

  if (!log.includes('## [Unreleased]')) {
    throw new Error(`${changelog} has no Unreleased section`);
  }

  await Deno.writeTextFile(
    changelog,
    log.replace(
      '## [Unreleased]',
      `## [Unreleased]\n\n## [${version}] - ${date}`,
    ),
  );

  console.log(`Bumped every package to ${version}. Next:
  git commit -am "Release ${version}"
  git tag v${version}
  git push origin main v${version}`);
}

async function verify(tag: string): Promise<void> {
  const version = tag.replace(/^v/, '');
  const mismatches: string[] = [];

  for (const name of packages) {
    const config = JSON.parse(
      await Deno.readTextFile(`packages/${name}/deno.json`),
    );

    if (config.version !== version) {
      mismatches.push(`${config.name}@${config.version}`);
    }

    if (
      config.peerDependencies?.emulon &&
      config.peerDependencies.emulon !== version
    ) {
      mismatches.push(
        `${config.name} peer emulon@${config.peerDependencies.emulon}`,
      );
    }
  }

  if (
    !(await Deno.readTextFile(cli)).includes(`const version = '${version}';`)
  ) {
    mismatches.push('CLI version constant');
  }

  if (!tag.startsWith('v') || !semver.test(version) || mismatches.length) {
    throw new Error(
      `Tag ${tag} does not match the packages: ${mismatches.join(', ')}`,
    );
  }

  await notes(version);
}

async function notes(version: string): Promise<string> {
  const log = await Deno.readTextFile(changelog);
  const start = log.indexOf(`## [${version}]`);

  if (start === -1) {
    throw new Error(`${changelog} has no ${version} section`);
  }

  const body = log.slice(log.indexOf('\n', start) + 1);
  const end = body.search(/^## \[/m);

  return (end === -1 ? body : body.slice(0, end)).trim();
}
