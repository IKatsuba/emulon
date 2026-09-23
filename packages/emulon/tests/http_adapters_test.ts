import { serveDeno } from '../src/runtime/deno-http.ts';
import { serveNode } from '../src/runtime/http.ts';

for (const serve of [serveDeno, serveNode]) {
  Deno.test(`${serve.name} preserves the request origin, path and query`, async () => {
    let received = '';
    const listener = await serve((request) => {
      received = request.url;

      return Promise.resolve(Response.redirect(new URL('/next', request.url)));
    });

    try {
      const response = await fetch(`${listener.url}/start?value=a%20b`, {
        redirect: 'manual',
      });

      await response.body?.cancel();

      if (received !== `${listener.url}/start?value=a%20b`) {
        throw new Error(`Unexpected request URL: ${received}`);
      }

      if (response.headers.get('location') !== `${listener.url}/next`) {
        throw new Error('Redirect lost the listener origin');
      }
    } finally {
      await listener.stop();
    }
  });

  Deno.test(`${serve.name} preserves separate response cookies`, async () => {
    const cookies = [
      'a=1; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
      'b=2; Path=/; HttpOnly',
    ];
    const listener = await serve(() => {
      const headers = new Headers({ 'x-fixture': 'cookies' });

      for (const cookie of cookies) {
        headers.append('set-cookie', cookie);
      }

      return Promise.resolve(new Response('ok', { headers }));
    });

    try {
      const response = await fetch(listener.url);
      const body = await response.text();

      if (body !== 'ok' || response.headers.get('x-fixture') !== 'cookies') {
        throw new Error('Response body or ordinary header changed');
      }

      if (
        JSON.stringify(response.headers.getSetCookie()) !==
          JSON.stringify(cookies)
      ) {
        throw new Error('Response cookies were lost or combined');
      }
    } finally {
      await listener.stop();
    }
  });
}
