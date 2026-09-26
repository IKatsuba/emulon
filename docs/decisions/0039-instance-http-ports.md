# 0039: Instance HTTP ports

## Context

[ADR 0006](0006-environment-http-lifecycle.md) assigns port 0 to every
provider-facing HTTP listener. This keeps parallel environments isolated, but an
application that embeds a provider URL at build time needs the same endpoint
after each restart. The port belongs to the environment's listener, not to a
provider's options or protocol. GitHub also shows why one number per instance is
insufficient: its `api` and `web` surfaces have separate listeners.

## Options

- Put a port option in each plugin factory. This duplicates host behavior in
  plugins and cannot express a common contract for multiple surfaces.
- Put a top-level map of instance and surface names in the configuration. This
  keeps registrations unchanged but separates an instance from its listener
  settings and makes renaming an instance a two-place edit.
- Allow a host-owned instance descriptor beside the existing bare registration.
  This keeps listener settings with the instance while preserving the current
  configuration for callers that do not need fixed ports.

## Decision

Use the instance descriptor. `defineConfig` and all entry points that accept a
configuration accept either a bare plugin registration or
`{ service: registration, ports?: { [surfaceName]: port } }` as a `services`
value:

```ts
import { defineConfig } from 'emulon';
import polar from '@emulon/polar';
import github from '@emulon/github';

export default defineConfig({
  services: {
    billing: { service: polar(), ports: { api: 43123 } },
    code: { service: github(), ports: { api: 43124, web: 43125 } },
  },
});
```

The `service` property is the registration produced by the existing factory. The
descriptor is not a plugin option, and the host passes only that registration's
options to plugin setup. No plugin has to change for a fixed port to work. Bare
registrations remain valid and preserve their inferred command clients and
instance names. A descriptor without `ports`, an omitted surface entry, and an
explicit port 0 all use the existing dynamic allocation. The host continues to
report actual endpoint URLs grouped by instance and surface, regardless of
whether a port was selected or allocated.

Port keys are the exact names passed to `ctx.http.surface(name)` and
`ctx.http.listen(name)`. Every configured port must be an integer from 0 to
65535 inclusive; 0 means dynamic allocation, while fixed ports are 1 through
65535. Configuration validation rejects other values and duplicate nonzero ports
across all instances and surfaces before any plugin setup or listener startup. A
duplicate reports `CONFIG_INVALID` and a safe message naming both
`instance.surface` pairs and the port, without echoing arbitrary configuration
values. This applies to file loading and direct `Emulon.start(config)` alike.
Host-generated port `CONFIG_INVALID` messages from `defineConfig` are safe to
expose through the configuration loader even when the call occurs during module
import. Use the existing branded `DomainError('CONFIG_INVALID', ...)` path for
that case, and preserve the same safe verdict in direct validation rather than
replacing it with a generic message. This extends
[ADR 0003](0003-config-loader.md)'s handling of import-time configuration
errors. Other project-code exceptions remain redacted; direct validation passes
through only verdicts the host wrote itself, so a `CONFIG_INVALID` `DomainError`
thrown by project code during validation, such as from a getter, keeps the
generic message.

The plugin contract does not statically declare surface names. The host
therefore checks configured names against surfaces actually listened to during
plugin setup and readiness. An unmatched name is `CONFIG_INVALID`, naming the
instance and surface without echoing the rejected value; any resources already
opened are rolled back under ADR 0006. The host cannot promise this particular
check at file import time without adding a surface declaration to every plugin.
Duplicate-port and numeric validation still happen before startup.

The host supplies the chosen port to its HTTP context and runtime listener
adapter. Node and Deno both bind provider listeners only to `127.0.0.1`. Binding
a fixed port never falls back to another port. If the operating system reports
that the port is occupied, startup fails with `PORT_IN_USE` and a safe message
naming the instance, surface and requested port. The runtime adapter recognizes
the native bind error; the environment preserves that code through rollback
instead of replacing it with the general startup error. This holds even when the
plugin catches the bind error and finishes setup without that surface: the host
records the failure itself and rolls the environment back. No endpoint or
discovery record is published after failure, and previously started surfaces are
closed as in ADR 0006. Other bind failures retain the existing redacted startup
error.

The local control API remains a separate listener on dynamic port 0. The
instance descriptor has no control API setting and does not alter discovery,
control authorization or status formatting. With no fixed port, all provider
listeners continue to use port 0, including parallel test environments.

## Consequences

The host must unwrap descriptors consistently for configuration validation,
typed clients, plugin setup, fixtures, compatibility and state ownership.
Runtime adapters accept a requested port while retaining their loopback bind.
Documentation should show the endpoint a desktop application embeds, how to
configure the matching instance surface, and the explicit failure when the port
is occupied. Tests should acquire candidate ports dynamically rather than
reserve hard-coded numbers.
