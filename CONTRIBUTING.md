# Contributing to emulon

Thank you for your interest in emulon. Bug reports, compatibility gaps,
documentation fixes and new plugins are all welcome.

## Before you start

- Read [`docs/design.md`](docs/design.md). It is the specification; code that
  disagrees with it is a question to raise, not a choice to make silently.
- For anything larger than a bug fix, open an issue first so the approach can be
  agreed before you invest time in it.
- Project rules are collected in [`AGENTS.md`](AGENTS.md). They apply equally to
  people and to coding agents.

## Development setup

You need [Deno](https://deno.com) 2.9 or later, and Node.js 22.13 or later with
npm on your `PATH` for the distribution checks.

```sh
git clone https://github.com/IKatsuba/emulon.git
cd emulon
deno task check
```

`deno task check` runs type checking, lint, formatting, the full test suite,
builds the npm archives and verifies them from clean installations under both
Node and Deno. It must pass before a pull request is merged. During development
you can run parts of it directly, for example
`deno test --allow-all
packages/github` or `deno fmt`.

Tests must stay offline: servers listen on loopback with dynamic ports, and no
test talks to a real provider or the public network.

## Pull requests

- Keep each pull request focused on one change and include tests for it.
- Write code, comments, docs and commit messages in English.
- Record new dependencies, public API additions and architectural choices as an
  ADR in [`docs/decisions`](docs/decisions).
- Update the affected plugin's compatibility manifest and README when provider
  behavior changes.
- Add an entry to [`CHANGELOG.md`](CHANGELOG.md) under "Unreleased" for
  user-visible changes.

Maintainers release as described in [`docs/releasing.md`](docs/releasing.md).

## Reporting bugs

Include the emulon and plugin versions, your runtime (Node or Deno and its
version), the provider client you use, and a minimal reproduction. For
compatibility gaps, describe what the real provider does and what emulon does
instead.

Security issues must not be reported in public issues; see
[`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
