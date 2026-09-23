# 0034: Release publishing

Status: Accepted.

## Context

Emulon publishes six npm packages: `emulon` and the official `@emulon/*`
plugins. Plugins declare `emulon` as a peer dependency, the CLI reports its own
version, and `deno task check` verifies the exact archives that `build:npm`
produces. Releases need to be reproducible, attributable to this repository and
free of long-lived publishing credentials.

## Options

- Publish from a maintainer machine with a personal npm token.
- Publish from GitHub Actions with a stored npm automation token.
- Publish from GitHub Actions through npm trusted publishing (OIDC), with
  provenance attestations.
- Stage versions from GitHub Actions and let a maintainer approve each with
  two-factor authentication.

Versioning can be independent per package or shared by all packages.

## Decision

All packages share one version. `deno task release version <x.y.z>` updates
every package manifest, the plugins' `emulon` peer range, the CLI version
constant and the changelog in one commit, and a `v<x.y.z>` tag triggers the
`release` workflow.

The workflow runs the full `check` workflow, verifies that the tag matches every
package, rebuilds the archives and stages them core first, skipping versions
that are already on npm so a failed run can be retried. Versions with a
prerelease suffix are staged under the `next` dist-tag. It then creates a GitHub
release from the changelog section.

CI never makes a version live. The workflow stages each archive with
`npm stage publish` and provenance, authenticated through npm trusted publishing
restricted to staging, or through a stage-only access token stored as
`NPM_TOKEN`. A maintainer reviews the staged versions and promotes each with
`npm stage approve` and two-factor authentication, so a compromised workflow or
leaked token cannot publish on its own.

Staging requires the package to exist on npm, so the first version of a new
package is published directly by a maintainer from the archives built by
`deno task build:npm`.

## Consequences

A plugin release always ships with a core release of the same version, even when
the core is unchanged. Publishing requires the `release` workflow and the `npm`
GitHub environment to be registered as trusted publisher on every package. The
CLI version constant is covered by a test that compares it with the core
manifest.
