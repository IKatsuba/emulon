async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Durable proof barrier timed out')),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Shared subprocess acceptance for source tests and installed npm archives. */
export async function durableProof(input: {
  alternate?: { command: string; args: string[] };
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}) {
  const directory = await Deno.realPath(
    await Deno.makeTempDir({ prefix: 'emulon-crash-' }),
  );
  const children = new Map<Deno.ChildProcess, () => Promise<void>>();
  const secret = 'whsec_' + btoa('durable-process-private-secret');
  const logs: string[] = [];

  function assert(value: unknown, message: string): asserts value {
    if (!value) {
      throw new Error('Durable proof: ' + message);
    }
  }

  let starts = 0;

  function spawn(mode: string, receiver = '') {
    const executor = input.alternate && starts++ % 2 ? input.alternate : input;
    const child = new Deno.Command(executor.command, {
      args: [...executor.args, mode, directory, receiver],
      cwd: input.cwd,
      ...(input.env ? { env: input.env, clearEnv: true } : {}),
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    const lines = child.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          buffer += chunk;

          let end;

          while ((end = buffer.indexOf('\n')) >= 0) {
            controller.enqueue(buffer.slice(0, end));

            buffer = buffer.slice(end + 1);
          }
        },
      }),
    ).getReader();
    let buffer = '';
    const stderr = new Response(child.stderr).text();

    children.set(child, async () => {
      try {
        child.kill('SIGKILL');
      } catch { /* Exited. */ }

      await bounded(child.status);
      await child.stdin.close();
      await lines.cancel();
      await stderr;
    });

    return {
      child,
      async line() {
        const value = await bounded(lines.read());

        if (value.done) {
          throw new Error(`${mode} exited before barrier: ${await stderr}`);
        }

        logs.push(value.value);

        return JSON.parse(value.value);
      },
      async finish(kill = false, success = true) {
        if (kill) {
          child.kill('SIGKILL');
        }

        const status = await bounded(child.status);

        children.delete(child);
        await child.stdin.close();
        await lines.cancel();

        const errors = await stderr;

        logs.push(errors);
        assert(
          kill || status.success === success,
          `${mode} exit ${status.code}: ${errors}`,
        );

        return errors;
      },
    };
  }

  async function inspect() {
    const p = spawn('inspect');
    const value = await p.line();

    await p.finish();

    return value;
  }

  async function crash(mode: string) {
    const p = spawn(mode);

    assert((await p.line()).barrier === mode, 'wrong barrier');
    await p.finish(true);
  }

  let host: ReturnType<typeof spawn> | undefined;
  let record: { url: string; id: string; token: string };
  const credentials: string[] = [];

  async function start() {
    host = spawn('host');

    assert((await host.line()).ready, 'host not ready');

    record = JSON.parse(
      await Deno.readTextFile(directory + '/.emulon/default.json'),
    );

    credentials.push(record.token);
  }

  async function call(path: string, body?: unknown) {
    const response = await fetch(record.url + path, {
      signal: AbortSignal.timeout(15000),
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer ' + record.token,
        'x-emulon-environment': record.id,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();

    assert(response.ok, `control ${path}: ${JSON.stringify(value)}`);

    return value;
  }

  const command = (name: string, value = {}) =>
    call('/command', { instance: 'mail', command: name, input: value });

  async function stop(kill = false) {
    if (!kill) {
      await call('/down', {});
    }

    await host!.finish(kill);

    host = undefined;

    if (kill) {
      await Deno.remove(directory + '/.emulon/default.json');
    }
  }

  const receipts: { bytes: number[]; id: string | null }[] = [];
  let hold = false;
  let received!: () => void;
  let release!: () => void;
  const receiver = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      receipts.push({
        bytes: Array.from(new Uint8Array(await request.arrayBuffer())),
        id: request.headers.get('svix-id'),
      });

      if (hold) {
        const gate = new Promise<void>((resolve) => release = resolve);

        received();
        await gate;
      }

      return new Response('private-receiver-response');
    },
  );

  try {
    const initial = await inspect();

    await crash('before');

    let state = await inspect();

    assert(
      state.uuid === initial.uuid && state.values[0].rows.length === 0 &&
        state.values[0].events.length === 0,
      'uncommitted entity/outbox survived',
    );
    await crash('after');

    state = await inspect();

    assert(
      state.values[0].rows.length === 1 &&
        state.values[0].events.length === 1 &&
        state.values[0].events[0].payload.entity ===
          state.values[0].rows[0].id,
      'committed entity/outbox lost',
    );

    const seed = spawn('seed');

    await seed.line();
    await seed.finish();

    const old = await inspect();

    await crash('reset-mid');
    assert(
      JSON.stringify(await inspect()) === JSON.stringify(old),
      'partial reset survived SQL rollback',
    );
    await crash('reset-after');

    state = await inspect();

    assert(
      state.uuid === initial.uuid &&
        state.values.every((
          v: { rows: unknown[]; events: unknown[]; generation: number },
          i: number,
        ) =>
          v.rows.length === 0 && v.events.length === 0 &&
          v.generation === old.values[i].generation + 1
        ),
      'reset did not commit every active instance',
    );

    const p = spawn('seed-delivery', `http://127.0.0.1:${receiver.addr.port}`);
    const seeded = await p.line();

    await p.finish();
    await start();
    assert(receipts.length === 2, 'pending and queued did not resume');

    const first = { ...record! };
    const deliveries = await command('webhooks.list');

    assert(
      deliveries.length === 2 &&
        deliveries.some((d: { eventId: string }) =>
          d.eventId === seeded.pending
        ) &&
        deliveries.some((d: { eventId: string }) =>
          d.eventId === seeded.queued
        ) &&
        deliveries.every((d: { status: string }) => d.status === 'succeeded'),
      'recovered deliveries not completed',
    );

    // Removing discovery must never permit stealing a live database.
    const discovery = directory + '/.emulon/default.json';

    await Deno.remove(discovery);

    const contender = spawn('host');
    const error = await contender.finish(false, false);

    assert(
      error.includes('STATE_IN_USE'),
      'second host did not refuse ownership',
    );
    await Deno.writeTextFile(discovery, JSON.stringify(record!), {
      mode: 0o600,
    });
    await stop(true);
    await start();
    assert(
      record!.id !== first.id && record!.token !== first.token,
      'control credentials reused',
    );

    const denied = await fetch(record!.url + '/identity', {
      headers: {
        authorization: 'Bearer ' + first.token,
        'x-emulon-environment': first.id,
      },
    });

    assert(denied.status === 401, 'old credentials accepted');
    await denied.body?.cancel();
    assert(
      JSON.stringify(await command('webhooks.list')) ===
          JSON.stringify(deliveries) && receipts.length === 2,
      'completed delivery replayed or pending duplicated',
    );

    hold = true;

    const receipt = new Promise<void>((resolve) => received = resolve);
    const pending = command('webhooks.send', {
      type: 'email.sent',
      data: {
        email_id: crypto.randomUUID(),
        from: 'a@example.test',
        to: ['b@example.test'],
        subject: 'Привет 🌍',
      },
      destination: 'app',
    }).catch(() => undefined);

    await bounded(Promise.race([
      receipt,
      pending.then(() => {
        throw new Error('Send ended before receipt');
      }),
    ]));

    const inflight = (await command('webhooks.list')).find((
      d: { status: string },
    ) => d.status === 'in-flight');

    assert(inflight, 'receipt lacks persisted claim');

    const claimed = await command('webhooks.inspect', { id: inflight.id });

    assert(
      claimed.attempts.length === 1 && !claimed.attempts[0].completedAt &&
        claimed.attempts[0].providerDeliveryId === receipts[2]!.id &&
        JSON.stringify(claimed.attempts[0].requestBytes) ===
          JSON.stringify(receipts[2]!.bytes),
      'receipt does not match uncompleted persisted attempt',
    );
    await stop(true);
    await pending;

    hold = false;

    release();
    await start();

    const inspection = await command('webhooks.inspect', { id: inflight.id });

    assert(
      inspection.delivery.status === 'failed' &&
        inspection.attempts.length === 1 &&
        inspection.attempts[0].outcome === 'unknown' &&
        inspection.attempts[0].errorCode === 'INTERRUPTED',
      'inflight recovery not failed/unknown',
    );
    assert(
      Number(receipts.length) === 3,
      'unknown attempt automatically replayed',
    );
    await stop(true);
    await start();
    assert(
      JSON.stringify(await command('webhooks.inspect', { id: inflight.id })) ===
          JSON.stringify(inspection) && Number(receipts.length) === 3,
      'recovery transition was not persisted',
    );
    await command('webhooks.redeliver', { id: inflight.id });

    const redelivery = await command('webhooks.inspect', { id: inflight.id });

    assert(
      redelivery.delivery.status === 'succeeded' &&
        redelivery.attempts.length === 2 &&
        redelivery.attempts[0].id !== redelivery.attempts[1].id &&
        redelivery.attempts[0].providerDeliveryId ===
          redelivery.attempts[1].providerDeliveryId &&
        JSON.stringify(redelivery.attempts[0].requestBytes) ===
          JSON.stringify(redelivery.attempts[1].requestBytes) &&
        JSON.stringify(receipts[2]) === JSON.stringify(receipts[3]),
      'redelivery did not retain exact bytes/provider ID',
    );

    const visible = JSON.stringify([
      await call('/identity'),
      deliveries,
      inspection,
      redelivery,
      logs,
    ]);

    for (
      const sensitive of [
        secret,
        ...credentials,
        'private-receiver-response',
        'svix-signature',
      ]
    ) {
      assert(
        !visible.includes(sensitive),
        'secret leaked in output/inspection',
      );
    }

    await stop();
    assert(
      (await inspect()).uuid === initial.uuid,
      'host changed database UUID',
    );
    console.log(
      'PASS durable process proof: SQL rollback/commit, atomic reset, kill lock release, host exclusion, pending/queued/completed, receipt/INTERRUPTED/redelivery, UUID and credentials, redaction',
    );
  } finally {
    release?.();
    await Promise.all([...children.values()].map((cleanup) => cleanup()));
    await receiver.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
}
