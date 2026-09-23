# Releasing

All packages are released together with one version; see
[ADR 0034](decisions/0034-release-publishing.md).

## Cut a release

1. Make sure `main` is green and `CHANGELOG.md` describes the changes under
   "Unreleased".
2. Bump the version and open its changelog section:

   ```sh
   deno task release version 0.2.0
   ```

3. Review the diff, then commit, tag and push:

   ```sh
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

The `release` workflow runs the full check, publishes every package to npm with
provenance and creates the GitHub release. A version such as `0.2.0-beta.1` is
published under the `next` dist-tag and marked as a prerelease. If the workflow
fails midway, re-run it: already published packages are skipped.

## One-time npm setup

1. Create the `emulon` organization on npm so the `@emulon` scope exists.
2. For the first release only, add a granular npm access token with publish
   rights to the `emulon` package and the `@emulon` scope as the `NPM_TOKEN`
   secret of the `npm` environment in the GitHub repository settings.
3. After the first release, open each package's settings on npmjs.com and add a
   trusted publisher: GitHub Actions, repository `IKatsuba/emulon`, workflow
   `release.yml`, environment `npm`.
4. Delete the `NPM_TOKEN` secret and, in each package's settings, require
   two-factor authentication and disallow tokens for publishing.
