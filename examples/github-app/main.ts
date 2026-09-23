import { Emulon } from 'emulon';
import github from '@emulon/github';
import { listen } from '../../packages/emulon/src/runtime/http.ts';
import { localClient } from './client.ts';
import { consent, exchange } from './authorization.ts';
import { sign } from './jwt.ts';
import { verifyWebhook } from './verify.ts';

export async function runExample() {
  const secret = crypto.randomUUID();
  const received: {
    event: string;
    delivery: string;
    payload: unknown;
    signatureVerified: boolean;
  }[] = [];
  const receiver = await listen(async (request) => {
    const body = await request.text();
    const signature = request.headers.get('x-hub-signature-256') ?? '';

    if (!await verifyWebhook(secret, body, signature)) {
      return new Response('Invalid signature', { status: 401 });
    }

    received.push({
      event: request.headers.get('x-github-event') ?? '',
      delivery: request.headers.get('x-github-delivery') ?? '',
      payload: JSON.parse(body),
      signatureVerified: true,
    });

    return new Response(null, { status: 204 });
  });

  try {
    await using env = await Emulon.start({
      services: {
        github: github({
          fixtures: {
            users: [{ login: 'igor' }],
            repositories: [{ owner: 'igor', name: 'demo', private: true }],
          },
          webhooks: { url: receiver.url, secret },
        }),
      },
    });
    const gh = env.services.github;
    const app = await gh.apps.create({
      slug: 'review-bot',
      permissions: { issues: 'write' },
      events: ['issues'],
      callbackUrls: [receiver.url + '/callback'],
    });
    const installation = await gh.installations.create({
      appId: app.id,
      account: 'igor',
      repositories: ['igor/demo'],
    });
    const seconds = Math.floor(Date.now() / 1000);
    const jwt = await sign(app.privateKey, {
      iss: app.id,
      iat: seconds - 60,
      exp: seconds + 600,
    });
    const appClient = localClient(env.endpoints.github.api!, jwt);
    const token = await appClient.rest.apps.createInstallationAccessToken({
      installation_id: Number(installation.id),
    });
    const client = localClient(env.endpoints.github.api!, token.data.token);
    const issue = await client.rest.issues.create({
      owner: 'igor',
      repo: 'demo',
      title: 'Hello from Octokit 🌍',
      body: 'A signed local webhook follows this issue.',
    });
    const deliveries = await gh.webhooks.list();

    if (deliveries.length !== 1) {
      throw new Error('Expected one issue delivery');
    }

    const delivery = await gh.webhooks.wait({
      id: deliveries[0]!.id,
      status: 'succeeded',
      timeout: '5s',
    });

    if (received.length !== 1) {
      throw new Error('Expected one verified webhook');
    }

    const inspection = await gh.webhooks.inspect({ id: delivery.id });
    const queued = await gh.webhooks.redeliver({ id: delivery.id });
    const redelivery = await gh.webhooks.wait({
      id: queued.id,
      status: 'succeeded',
      timeout: '5s',
    });
    const redeliveryInspection = await gh.webhooks.inspect({
      id: redelivery.id,
    });

    if (received.slice().length !== 2) {
      throw new Error(
        'Expected two verified deliveries of the installation issue',
      );
    }

    const deliveryInspections = [inspection, redeliveryInspection].map(
      ({ delivery, attempts }) => ({
        id: delivery.id,
        status: delivery.status,
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          providerDeliveryId: attempt.providerDeliveryId,
          responseStatus: attempt.responseStatus,
          completedAt: attempt.completedAt,
        })),
      }),
    );
    const callback = receiver.url + '/callback';
    const code = await consent(
      env.endpoints.github.web!,
      app.clientId,
      callback,
      crypto.randomUUID(),
    );
    const userToken = await exchange(
      env.endpoints.github.web!,
      app,
      code,
      callback,
    );
    const userClient = localClient(env.endpoints.github.api!, userToken);
    const user = await userClient.rest.users.getAuthenticated();
    const userIssue = await userClient.rest.issues.create({
      owner: 'igor',
      repo: 'demo',
      title: 'Hello from a local user',
    });
    const userDeliveries = await gh.webhooks.list();
    const userDelivery = userDeliveries.find((item) => item.id !== delivery.id);

    if (!userDelivery) {
      throw new Error('Expected user issue delivery');
    }

    await gh.webhooks.wait({
      id: userDelivery.id,
      status: 'succeeded',
      timeout: '5s',
    });

    if (received.slice().length !== 3) {
      throw new Error('Expected three verified webhooks');
    }

    return {
      user: user.data,
      userIssue: userIssue.data,
      userWebhook: received[2]!,
      issue: issue.data,
      deliveryStatus: delivery.status,
      deliveryInspections,
      redeliveryStatus: redelivery.status,
      redeliveredWebhook: received[1]!,
      webhook: received[0]!,
    };
  } finally {
    await receiver.stop();
  }
}

if (import.meta.main) {
  const result = await runExample();

  console.log(JSON.stringify(result, null, 2));
}
