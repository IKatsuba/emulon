import { compatibility } from '../packages/calcom/src/compatibility.ts';

/** Runs against installed archives, without workspace imports or provider access. */
export function calcomProof(prefix: string): string {
  return `
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { Emulon } from "${prefix}emulon";
import calcom from "${prefix}@emulon/calcom";
import { serveEnvironment } from "./node_modules/emulon/esm/control/server.js";
import { runProjectCLI } from "./node_modules/emulon/esm/cli/project.js";
const manifest = ${JSON.stringify(compatibility)};
const directory = "./calcom-project";
await mkdir(directory);
let receiverStatus = 500;
const received = [];
const secret = "installed_секрет_£";
const receiver = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const signature = request.headers["x-cal-signature-256"];
  const valid = request.method === "POST" && request.headers["x-cal-webhook-version"] === "2021-10-20" && signature === createHmac("sha256", secret).update(body).digest("hex");
  received.push({ body: body.toString("utf8"), valid });
  response.writeHead(valid ? receiverStatus : 400); response.end();
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const destination = { id: "receiver", url: "http://127.0.0.1:" + receiver.address().port, secret, types: ["BOOKING_CREATED"], enabled: true };
const config = { services: { cal: calcom({ destinations: [destination] }) } };
const started = await Emulon.start(config);
let host = await serveEnvironment(config, { directory });
let connected;
function assert(value, message) { if (!value) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}
function equal(a, b) { assert(JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)), "Cal.com mismatch: " + JSON.stringify(a)); }
const cli = async (args) => {
  const result = await runProjectCLI(["cal", ...args, "--json"], undefined, directory);
  assert(result.code === 0, result.stderr);
  return JSON.parse(result.stdout);
};
try {
  const pkg = JSON.parse(await readFile("./node_modules/@emulon/calcom/package.json", "utf8"));
  equal(pkg.emulon.compatibility, manifest);
  equal(await started.services.cal.compatibility.get({}), manifest);
  const input = { title: "Installed", slug: "installed", lengthInMinutes: 30, slots: ["2099-06-01T10:00:00Z"] };
  const typed = await started.services.cal.eventTypes.create(input);
  const startedKey = await started.services.cal.keys.create({});
  const startedRead = await fetch(started.endpoints.cal.api + "/v2/event-types/" + typed.id, { headers: { authorization: "Bearer " + startedKey.apiKey, "cal-api-version": "2026-06-12" } });
  assert(startedRead.status === 200, "Started HTTP failed");
  equal((await startedRead.json()).data, typed);
  const type = await cli(["event-types", "create", "--title", input.title, "--slug", input.slug, "--length-in-minutes", "30", "--slots", JSON.stringify(input.slots)]);
  const { apiKey } = await cli(["keys", "create"]);
  connected = await Emulon.connect({ config, directory });
  equal(await connected.services.cal.eventTypes.get({ id: type.id }), type);
  const sdkType = await connected.services.cal.eventTypes.create({ ...input, title: "Connected" });
  equal(await cli(["event-types", "get", "--id", String(sdkType.id)]), sdkType);
  equal(await cli(["event-types", "list"]), [type, sdkType]);
  equal(await cli(["compatibility", "get"]), manifest);
  equal(await connected.services.cal.compatibility.get({}), manifest);
  await connected.dispose();
  connected = undefined;
  await host.dispose();
  host = await serveEnvironment(config, { directory });
  connected = await Emulon.connect({ config, directory });
  const response = await fetch(connected.endpoints.cal.api + "/v2/slots?eventTypeId=" + type.id + "&start=2099-06-01&end=2099-06-01", { headers: { authorization: "Bearer " + apiKey, "cal-api-version": "2024-09-04" } });
  assert(response.status === 200, "Restart HTTP failed");
  const expected = { "2099-06-01": [{ start: "2099-06-01T10:00:00.000Z" }] };
  equal(await response.json(), { status: "success", data: expected });
  equal(await cli(["slots", "list", "--event-type-id", String(type.id), "--start", "2099-06-01", "--end", "2099-06-01"]), expected);
  const attendee = { name: "Installed Ада 🗓️", email: "ada@example.test", timeZone: "UTC" };
  const booking = await cli(["bookings", "create", "--event-type-id", String(type.id), "--start", input.slots[0], "--attendee", JSON.stringify(attendee)]);
  equal(await connected.services.cal.bookings.get({ uid: booking.uid }), booking);
  const [delivery] = await connected.services.cal.webhooks.list({});
  await connected.services.cal.webhooks.wait({ id: delivery.id, status: "failed", timeout: "5s" });
  const failed = await cli(["webhooks", "inspect", delivery.id]);
  equal(failed.attempts.length, 1); equal(failed.attempts[0].responseStatus, 500);
  assert(!JSON.stringify(failed).includes(secret), "Inspection secret leak");
  receiverStatus = 200;
  await cli(["webhooks", "redeliver", delivery.id]);
  await cli(["webhooks", "wait", delivery.id, "--status", "succeeded", "--timeout", "5s"]);
  equal((await connected.services.cal.webhooks.inspect({ id: delivery.id })).attempts.length, 2);
  equal(received.length, 2); assert(received.every((r) => r.valid), "Invalid Cal.com signature");
  equal(received[0].body, received[1].body);
  equal(JSON.parse(received[0].body).payload.uid, booking.uid);

  const bookingRead = await fetch(connected.endpoints.cal.api + "/v2/bookings/" + booking.uid, { headers: { authorization: "Bearer " + apiKey, "cal-api-version": "2026-02-25" } });
  assert(bookingRead.status === 200, "Booking HTTP read failed");
  equal((await bookingRead.json()).data, booking);
  equal(await connected.services.cal.slots.list({ eventTypeId: sdkType.id, start: "2099-06-01", end: "2099-06-01" }), {});
  equal((await connected.events.list({ type: "BOOKING_CREATED" })).length, 1);
  await connected.dispose(); connected = undefined;
  await host.dispose(); host = await serveEnvironment(config, { directory });
  connected = await Emulon.connect({ config, directory });
  equal(await cli(["bookings", "get", "--uid", booking.uid]), booking);
  equal((await connected.events.list({ type: "BOOKING_CREATED" })).length, 1);
  equal(await connected.services.cal.slots.list({ eventTypeId: type.id, start: "2099-06-01", end: "2099-06-01" }), {});
  await connected.reset();
  equal(await connected.services.cal.eventTypes.list({}), []);
  equal(await connected.services.cal.compatibility.get({}), manifest);
  const invalidated = await fetch(connected.endpoints.cal.api + "/v2/event-types/" + type.id, { headers: { authorization: "Bearer " + apiKey, "cal-api-version": "2026-06-12" } });
  assert(invalidated.status === 401, "Reset key survived");
  await invalidated.json();
} finally {
  await connected?.dispose();
  await host.dispose();
  await started.dispose();
  await new Promise((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
}
console.log("Cal.com installed CLI/SDK/HTTP, UTC slots, signed delivery/manual recovery, restart/reset and manifest parity passed");
`;
}
