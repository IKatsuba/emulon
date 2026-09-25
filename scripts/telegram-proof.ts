import { compatibility } from '../packages/telegram/src/compatibility.ts';

/**
 * Bot foundation smoke for the installed archive: no workspace imports, no
 * grammY and no provider access. The requests are the ones grammY sends: POST
 * `<apiRoot>/bot<token>/<method>` with a JSON body.
 */
export function telegramProof(prefix: string): string {
  return `
import { readFile } from "node:fs/promises";
import { Emulon, defineCompatibility } from "${prefix}emulon";
import telegram from "${prefix}@emulon/telegram";
const manifest = ${JSON.stringify(compatibility)};
function assert(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Telegram mismatch: " + label);
}
const channel = { id: -1001234567890, title: "Local News", username: "local_news" };
const env = await Emulon.start({ services: { tg: telegram({ fixtures: { channels: [channel] } }) } });
try {
  const pkg = JSON.parse(await readFile("./node_modules/@emulon/telegram/package.json", "utf8"));
  equal(defineCompatibility(pkg.emulon.compatibility), manifest, "npm metadata");
  equal(await env.services.tg.compatibility.get({}), manifest, "installed command");
  assert(!manifest.capabilities.includes("webhooks"), "Webhook capability claimed");
  assert(!Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).some((name) => name === "grammy" || name.startsWith("@grammyjs/")), "grammY shipped");
  const apiRoot = env.endpoints.tg.api;
  assert(!apiRoot.endsWith("/"), "Endpoint has a trailing slash");
  const bot = await env.services.tg.bots.create({ username: "installed_bot", firstName: "Installed" });
  assert(/^\\d+:[A-Za-z0-9_-]{43}$/.test(bot.token) && bot.token.startsWith(bot.id + ":"), "Unexpected token shape");
  const call = async (token, method, body = {}) => {
    const response = await fetch(apiRoot + "/bot" + token + "/" + method, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const text = await response.text();
    assert(!text.includes(bot.token.split(":")[1]), "Token reached a response");
    return { status: response.status, body: JSON.parse(text) };
  };
  const me = await call(bot.token, "getMe");
  equal(me.status, 200, "getMe status");
  equal([me.body.ok, me.body.result.id, me.body.result.is_bot, me.body.result.username], [true, bot.id, true, "installed_bot"], "getMe result");
  equal(await call(bot.id + ":" + "A".repeat(43), "getMe"), { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }, "wrong token");
  equal(await call("malformed", "getMe"), { status: 404, body: { ok: false, error_code: 404, description: "Not Found" } }, "malformed token");
  equal((await call(bot.token, "setWebhook", { url: "http://127.0.0.1:1" })).status, 501, "setWebhook");
  equal((await call(bot.token, "notAMethod")).status, 404, "unknown method");
  await env.reset();
  equal((await call(bot.token, "getMe")).status, 401, "token after reset");
  const again = await env.services.tg.bots.create({ username: "installed_bot", firstName: "Again" });
  equal(again.id, bot.id, "reused ID");
  equal((await call(bot.token, "getMe")).status, 401, "stale token with a reused ID");
  equal((await call(again.token, "getMe")).body.result.first_name, "Again", "reissued token");
} finally {
  await env.dispose();
}
console.log("Telegram installed getMe, token rejection, 501 methods, reset and manifest parity passed");
`;
}
