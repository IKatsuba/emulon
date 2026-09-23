# Releasing

All packages are released together with one version; see
[ADR 0034](decisions/0034-release-publishing.md). CI only stages versions on
npm; a maintainer with two-factor authentication makes them live.

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

4. The `release` workflow runs the full check, stages every package on npm with
   provenance and creates the GitHub release. Review and approve the stages (npm
   CLI 11.15.0 or later), core first:

   ```sh
   npm stage list
   npm stage view <stage-id>
   npm stage approve <stage-id>
   ```

A version such as `0.2.0-beta.1` is staged under the `next` dist-tag and marked
as a prerelease on GitHub. If the workflow fails midway, reject any stages it
left behind with `npm stage reject <stage-id>` and re-run it; versions that are
already published are skipped.

## First release

Staging works only for packages that already exist on npm, so the first version
is published by hand from a machine logged in to npm with 2FA:

1. Create the `emulon` organization on npm so the `@emulon` scope exists.
2. Prepare and verify the release:

   ```sh
   deno task release version 0.1.0
   git commit -am "Release 0.1.0"
   deno task check
   ```

3. Publish the verified archives, core first:

   ```sh
   for archive in emulon emulon-resend emulon-github emulon-stripe \
     emulon-calcom emulon-polar; do
     npm publish "dist/npm/$archive-0.1.0.tgz" --access public
   done
   ```

4. Push the tag. The workflow finds every package already published, skips
   staging and creates the GitHub release:

   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```

## CI credentials

Use one of these for the `release` workflow:

- **Trusted publishing (preferred, no secret).** In each package's settings on
  npmjs.com add a trusted publisher: GitHub Actions, repository
  `IKatsuba/emulon`, workflow `release.yml`, environment `npm`, restricted to
  staging.
- **Stage-only token.** Create a granular token with "Read and write (stage
  only)" for the `emulon` package and the `@emulon` scope and store it as the
  `NPM_TOKEN` secret of the `npm` environment in the repository settings.

Neither can publish a version directly. Once trusted publishing is configured,
disallow token publishing in each package's settings.
