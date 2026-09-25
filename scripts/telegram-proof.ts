import { compatibility } from '../packages/telegram/src/compatibility.ts';

/**
 * Telegram smoke for the installed archive: no workspace imports, no grammY
 * and no provider access. The requests are the ones grammY sends: POST
 * `<apiRoot>/bot<token>/<method>` with a JSON body. Long polls run on the
 * runtime's own listener, so cancellation is proven under Node and Deno. A
 * project host then runs the declared consumer's publish-and-drain loop with
 * reactions set by the installed CLI and SDK, comparing both views.
 */
export function telegramProof(prefix: string): string {
  return `
import { mkdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { Emulon, defineCompatibility } from "${prefix}emulon";
import telegram from "${prefix}@emulon/telegram";
import { serveEnvironment } from "./node_modules/emulon/esm/control/server.js";
import { runProjectCLI } from "./node_modules/emulon/esm/cli/project.js";
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
  assert(!Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).some((name) => name === "grammy" || name.startsWith("@grammyjs/") || name === "md-to-telegram"), "Test dependency shipped");
  const apiRoot = env.endpoints.tg.api;
  assert(!apiRoot.endsWith("/"), "Endpoint has a trailing slash");
  const bot = await env.services.tg.bots.create({ username: "installed_bot", firstName: "Installed" });
  assert(/^\\d+:[A-Za-z0-9_-]{43}$/.test(bot.token) && bot.token.startsWith(bot.id + ":"), "Unexpected token shape");
  const call = async (token, method, body = {}, signal) => {
    const response = await fetch(apiRoot + "/bot" + token + "/" + method, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
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
  const sent = [];
  for (const chat_id of [channel.id, "@Local_News"]) {
    const response = await call(bot.token, "sendMessage", { chat_id, text: "*Part* 1\\\\.", parse_mode: "MarkdownV2", disable_notification: true, link_preview_options: { is_disabled: false } });
    equal(response.status, 200, "sendMessage status");
    sent.push(response.body.result);
  }
  equal(sent.map((message) => [message.message_id, message.chat.id, message.text, message.entities]), [1, 2].map((id) => [id, channel.id, "Part 1.", [{ type: "bold", offset: 0, length: 4 }]]), "sendMessage result");
  equal(await call(bot.token, "sendMessage", { chat_id: channel.id, text: "Unescaped.", parse_mode: "MarkdownV2" }), { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } }, "bad markup");
  equal((await env.services.tg.messages.list({ chatId: channel.id })).map((message) => [message.messageId, message.source, message.text]), [[1, "*Part* 1\\\\.", "Part 1."], [2, "*Part* 1\\\\.", "Part 1."]], "messages list");
  const thumbs = (total_count) => [{ type: { type: "emoji", emoji: "👍" }, total_count }];
  const react = (count) => env.services.tg.reactions.set({ chatId: channel.id, messageId: 1, reactions: thumbs(count) });
  equal((await react(1)).queued, 0, "reaction before subscription");
  equal((await call(bot.token, "getUpdates", { allowed_updates: ["message_reaction_count"] })).body, { ok: true, result: [] }, "subscription");
  equal((await react(2)).queued, 1, "subscribed reaction");
  equal((await env.services.tg.updates.inspect({ botId: bot.id })).pending, 1, "updates inspect");
  const drained = await call(bot.token, "getUpdates", { limit: 100, timeout: 0 });
  equal(drained.body.result.map((update) => [update.update_id, update.message_reaction_count.chat.id, update.message_reaction_count.chat.username, update.message_reaction_count.message_id, update.message_reaction_count.reactions]), [[1, channel.id, "local_news", 1, thumbs(2)]], "drained update");
  equal((await call(bot.token, "getUpdates", { offset: 2, timeout: 0 })).body.result, [], "confirmed drain");
  const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
  let started = performance.now();
  const woken = call(bot.token, "getUpdates", { timeout: 30 });
  await pause();
  equal((await call(bot.token, "getUpdates", {})).status, 409, "overlapping poll");
  await react(3);
  equal((await woken).body.result.map((update) => update.update_id), [2], "woken poll");
  assert(performance.now() - started < 5000, "Long poll did not wake");
  // A reset socket is an exact disconnect; an aborted fetch may be resent.
  const url = new URL(apiRoot);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.on("error", () => {});
  const pollBody = JSON.stringify({ offset: 3, timeout: 30 });
  socket.write("POST /bot" + bot.token + "/getUpdates HTTP/1.1\\r\\nhost: " + url.host + "\\r\\ncontent-type: application/json\\r\\ncontent-length: " + new TextEncoder().encode(pollBody).length + "\\r\\n\\r\\n" + pollBody);
  await pause();
  equal((await call(bot.token, "getUpdates", {})).status, 409, "socket poll is waiting");
  socket.resetAndDestroy();
  let released;
  for (let attempt = 0; attempt < 100 && released?.status !== 200; attempt++) {
    released = await call(bot.token, "getUpdates", { timeout: 0 });
    if (released.status !== 200) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  equal(released.body, { ok: true, result: [] }, "poll after disconnect");
  started = performance.now();
  const resetting = call(bot.token, "getUpdates", { timeout: 30 });
  await pause();
  await env.reset();
  equal(await resetting, { status: 503, body: { ok: false, error_code: 503, description: "Service Unavailable: the request was cancelled" } }, "poll across reset");
  assert(performance.now() - started < 5000, "Reset waited for the poll");
  equal((await call(bot.token, "getMe")).status, 401, "token after reset");
  const again = await env.services.tg.bots.create({ username: "installed_bot", firstName: "Again" });
  equal(again.id, bot.id, "reused ID");
  equal((await call(bot.token, "getMe")).status, 401, "stale token with a reused ID");
  equal((await call(again.token, "getMe")).body.result.first_name, "Again", "reissued token");
} finally {
  await env.dispose();
}
const stopped = await Emulon.start({ services: { tg: telegram({ fixtures: { channels: [channel] } }) } });
const stopBot = await stopped.services.tg.bots.create({ username: "stopping_bot", firstName: "Stopping" });
const stopping = fetch(stopped.endpoints.tg.api + "/bot" + stopBot.token + "/getUpdates", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeout: 30 }),
}).then(async (response) => (await response.json()).error_code, () => "network");
await new Promise((resolve) => setTimeout(resolve, 200));
const stopStarted = performance.now();
await stopped.dispose();
const stopOutcome = await stopping;
assert(stopOutcome === 503 || stopOutcome === "network", "Shutdown answered the poll with " + stopOutcome);
assert(performance.now() - stopStarted < 5000, "Shutdown waited for the poll");
const directory = "./telegram-project";
await mkdir(directory);
const config = { services: { tg: telegram({ fixtures: { channels: [channel] } }) } };
const host = await serveEnvironment(config, { directory });
let connected;
try {
  connected = await Emulon.connect({ config, directory });
  const tg = connected.services.tg;
  const cli = async (...args) => {
    const result = await runProjectCLI(["tg", ...args, "--json"], undefined, directory);
    if (result.code !== 0) throw new Error("Telegram CLI failed: " + args.slice(0, 2).join(" "));
    return JSON.parse(result.stdout);
  };
  equal(await cli("compatibility", "get"), manifest, "CLI manifest");
  equal(await tg.compatibility.get({}), manifest, "connected manifest");
  const issued = await cli("bots", "create", "--username", "project_bot", "--first-name", "Project");
  const method = async (name, body) => {
    const response = await fetch(connected.endpoints.tg.api + "/bot" + issued.token + "/" + name, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const envelope = await response.json();
    if (!envelope.ok) throw new Error("Telegram " + name + " failed with " + envelope.error_code);
    return envelope.result;
  };
  // One run of the declared consumer: drain from the stored offset, or from the
  // start on a first run, and store update_id + 1 of the last update.
  const drain = async (stored) => {
    const updates = [];
    let offset = stored;
    while (true) {
      const batch = await method("getUpdates", { ...(offset === undefined ? {} : { offset }), limit: 100, timeout: 0, allowed_updates: ["message_reaction_count"] });
      if (batch.length === 0) return { updates, offset };
      updates.push(...batch);
      offset = batch.at(-1).update_id + 1;
    }
  };
  const first = await drain(undefined);
  equal(first, { updates: [], offset: undefined }, "first consumer run");
  const options = { parse_mode: "MarkdownV2", disable_notification: true, link_preview_options: { is_disabled: false } };
  const parts = ["*Digest* part 1\\\\.", "_Digest_ part 2\\\\."];
  equal([(await method("sendMessage", { chat_id: channel.id, text: parts[0], ...options })).message_id, (await method("sendMessage", { chat_id: "@" + channel.username, text: parts[1], ...options })).message_id], [1, 2], "multipart post");
  const listed = await tg.messages.list({ chatId: channel.id });
  equal(listed.map((message) => message.source), parts, "listed parts");
  equal(await cli("messages", "list", "--chat-id", String(channel.id)), listed, "messages list parity");
  const counts = (total_count) => [{ type: { type: "emoji", emoji: "👍" }, total_count }];
  equal((await cli("reactions", "set", "--chat-id", String(channel.id), "--message-id", "1", "--reactions", JSON.stringify(counts(2)))).queued, 1, "CLI reaction");
  equal((await tg.reactions.set({ chatId: channel.id, messageId: 2, reactions: counts(5) })).queued, 1, "SDK reaction");
  const inspected = await tg.updates.inspect({ botId: issued.id });
  equal(await cli("updates", "inspect", "--bot-id", String(issued.id)), inspected, "updates inspect parity");
  equal([inspected.allowedUpdates, inspected.pending], [["message_reaction_count"], 2], "inspected queue");
  const second = await drain(first.offset);
  equal(second.updates, inspected.updates, "drained updates");
  equal(second.updates.map((update) => [update.update_id, update.message_reaction_count.message_id, update.message_reaction_count.reactions]), [[1, 1, counts(2)], [2, 2, counts(5)]], "drained reactions");
  equal(second.offset, 3, "stored offset");
  equal((await tg.updates.inspect({ botId: issued.id })).pending, 0, "confirmed queue");
  equal(await drain(second.offset), { updates: [], offset: 3 }, "next consumer run");
} finally {
  await connected?.dispose();
  await host.dispose();
}
console.log("Telegram installed getMe, sendMessage, messages list, reactions, getUpdates, long poll cancellation, token rejection, 501 methods, reset, consumer drain and CLI/SDK/manifest parity passed");
`;
}
