# emulon

Local third-party services for application development and testing.

Emulon runs provider-compatible emulators of services such as GitHub, Stripe,
Resend, Cal.com and Polar on loopback. Your application talks to them with its
usual provider clients, while you control state, credentials, events, webhook
deliveries and failure scenarios through one CLI and one typed SDK that share
the same command contract.

- **Real clients, local endpoints.** Point the official SDK (Octokit, `stripe`,
  `resend`, `@polar-sh/sdk`, ...) at the emulator; nothing reaches the real
  provider.
- **Webhooks are first-class.** Events are recorded atomically with state
  changes and delivered with provider-shaped signatures, retries, inspection and
  redelivery.
- **Authorization flows included.** GitHub Apps with JWTs, installation tokens,
  local consent pages and user tokens.
- **Deterministic tests.** Isolated environments on dynamic ports, reset to
  fixtures, and wait operations instead of sleeps.
- **Explicit compatibility.** Every plugin ships a manifest of the API versions
  and operations it implements; unsupported operations fail loudly.

> Emulon is at an early stage (`0.1.x`). Each plugin covers a bounded, tested
> slice of its provider, described in its compatibility manifest.

## Packages

| Package                                 | Emulates                                                        |
| --------------------------------------- | --------------------------------------------------------------- |
| [`emulon`](packages/emulon)             | CLI, SDK, plugin authoring API and runtime                      |
| [`@emulon/github`](packages/github)     | GitHub Apps, installations, user authorization, issues          |
| [`@emulon/resend`](packages/resend)     | Resend email sending and reading                                |
| [`@emulon/stripe`](packages/stripe)     | Stripe catalog, promotion codes, Checkout, refunds and disputes |
| [`@emulon/calcom`](packages/calcom)     | Cal.com API v2 event types, availability and bookings           |
| [`@emulon/polar`](packages/polar)       | Polar customers, their webhooks and license key activation      |
| [`@emulon/telegram`](packages/telegram) | Telegram Bot API channel posts and reaction-count polling       |

Packages run on Node.js 22.13 or later and on Deno.

## Quick start

```sh
npm install --save-dev emulon
npx emulon init
npx emulon add github resend
npx emulon up
```

`emulon init` creates `emulon.config.ts`; `emulon add` installs plugins and
registers them as named service instances:

```ts
import { defineConfig } from 'emulon';
import github from '@emulon/github';
import resend from '@emulon/resend';

export default defineConfig({
  services: {
    github: github({
      fixtures: {
        users: [{ login: 'octocat' }],
        repositories: [{ owner: 'octocat', name: 'demo', private: true }],
      },
    }),
    mail: resend(),
  },
});
```

Each instance listens on a dynamically allocated loopback port unless it pins
one. An application that embeds a provider URL at build time can give an
instance a fixed port per surface by wrapping its registration:

```ts
export default defineConfig({
  services: {
    github: {
      service: github(),
      ports: { api: 43124, web: 43125 },
    },
    mail: resend(),
  },
});
```

`ports` keys are the instance's surface names (`api`, and `web` for GitHub and
Stripe); an omitted surface or port 0 stays dynamic. Ports are integers from 1
to 65535, bound on `127.0.0.1` only, and never replaced by another port: an
occupied port fails startup with `PORT_IN_USE`, and the same port on two
surfaces, or a surface the plugin does not serve, is `CONFIG_INVALID`. The local
control API always uses a dynamic port. See
[ADR 0039](docs/decisions/0039-instance-http-ports.md).

While `emulon up` is running, drive services from another terminal:

```sh
emulon status
emulon github apps create --slug review-bot
emulon events --type issues.opened --follow
emulon reset
emulon down
```

## Use it from tests

The SDK starts a private environment and disposes of it automatically:

```ts
import { Emulon } from 'emulon';
import resend from '@emulon/resend';
import { Resend } from 'resend';

await using env = await Emulon.start({ services: { mail: resend() } });

const { apiKey } = await env.services.mail.keys.create();
const client = new Resend(apiKey, { baseUrl: env.endpoints.mail.api });
await client.emails.send({
  from: 'Acme <sender@example.test>',
  to: ['recipient@example.test'],
  subject: 'Hello',
  html: '<p>Local only</p>',
});

console.log(await env.services.mail.emails.list());
```

See each package README and the [examples](examples) for complete scenarios.

## Documentation

- [Design](docs/design.md): architecture, plugin contract and command model
- [Events and delivery](docs/events-and-delivery.md)
- [Durable state](docs/durable-state.md)
- [Compatibility manifests](docs/compatibility.md)
- [Distribution](docs/distribution.md)
- [Architecture decision records](docs/decisions)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a pull request, and report vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
