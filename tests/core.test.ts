import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { settingsSchema } from "../shared/settings.ts";
import { readSecretFile, resolveCredential, SecretStore, validateSecret } from "../server/credentials.ts";
import { parseTarget, DaemonConnector } from "../server/daemon.ts";
import { abortable, PinError } from "../server/errors.ts";
import { TaskOwner } from "../server/pin.ts";

async function temporary(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "pin-unit-"));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test("settings default to automatic only; no secret value exists in schema", () => {
  assert.equal(settingsSchema.parse({}).fallbackEnabled, false);
  assert.equal("password" in settingsSchema.parse({ password: "secret" }), false);
  assert.equal(settingsSchema.safeParse({ environmentName: "$(cat file)" }).success, false);
});
test("targets accept loopback, TLS and automatic Unix sockets; reject credentials, remote ws and query", () => {
  assert.equal(parseTarget("0.0.0.0:6767", true).url, "ws://127.0.0.1:6767/ws");
  assert.equal(parseTarget("[::]:6767", true).url, "ws://[::1]:6767/ws");
  assert.equal(parseTarget("ws://localhost:6767/ws").local, true);
  assert.equal(parseTarget("wss://example.com/ws").local, false);
  assert.equal(parseTarget("unix:///tmp/test.sock", true).socketPath, "/tmp/test.sock");
  for (const url of ["ws://example.com/ws", "ws://user:password@localhost/ws", "ws://localhost/ws?token=secret", "ws://localhost/ws#token", "https://localhost/ws", "ws://localhost/", "not an address"]) assert.throws(() => parseTarget(url), PinError);
});
test("secret storage is atomic, private, supports replace/delete, and not in ordinary settings", async (t) => {
  const store = new SecretStore(await temporary(t));
  assert.equal(await store.stored(), false);
  await store.save(" space-sensitive password ");
  assert.equal(await store.read(), " space-sensitive password ");
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  await Promise.all([store.save("first"), store.save("second")]);
  assert.equal(await readFile(store.path, "utf8"), "second");
  await store.delete(); assert.equal(await store.stored(), false);
  await store.delete();
});
test("file credentials preserve spaces and accept one terminal newline; reject directories, links, empty, large and multiline", async (t) => {
  const dir = await temporary(t); const path = join(dir, "credential");
  await writeFile(path, " secret \r\n"); assert.equal(await readSecretFile(path), " secret ");
  await symlink(path, join(dir, "link")); await assert.rejects(readSecretFile(join(dir, "link")), PinError);
  await assert.rejects(readSecretFile(dir), PinError);
  for (const value of ["", "a\nb", "a\n\n", "x".repeat(20_000), "a\0b"]) {
    await writeFile(path, value); await assert.rejects(readSecretFile(path), PinError);
  }
  assert.throws(() => validateSecret({ password: "secret" }), PinError);
  await assert.rejects(readSecretFile("relative"), PinError);
});
test("sources are explicit and env/file secrets are freshly resolved", async (t) => {
  const home = await temporary(t); const store = new SecretStore(home); const filePath = join(home, "credential");
  const env = { TEST_PASSWORD: "first" };
  const settings = settingsSchema.parse({ credentialSource: "environment", environmentName: "TEST_PASSWORD" });
  assert.deepEqual(await resolveCredential(settings, store, env), { kind: "password", value: "first" });
  env.TEST_PASSWORD = "rotated"; assert.equal((await resolveCredential(settings, store, env)).value, "rotated");
  await assert.rejects(resolveCredential(settings, store, {}), { code: "environment_missing" });
  await writeFile(filePath, "token\n");
  assert.deepEqual(await resolveCredential({ ...settings, credentialSource: "file", filePath, fileKind: "localCredential" }, store), { kind: "localCredential", value: "token" });
  await writeFile(filePath, "new-token"); assert.equal((await resolveCredential({ ...settings, credentialSource: "file", filePath }, store)).value, "new-token");
});
test("runtime pid endpoint takes precedence; no default-port guessing", async (t) => {
  const home = await temporary(t); const connector = new DaemonConnector(home, {});
  await assert.rejects(connector.automaticTarget(), { code: "home_unavailable" });
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:1234" } }));
  assert.equal((await connector.automaticTarget()).url, "ws://127.0.0.1:1234/ws");
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:4321" }));
  assert.equal((await connector.automaticTarget()).url, "ws://127.0.0.1:4321/ws");
});
test("private secret parent symlinks are rejected", async (t) => {
  const home = await temporary(t); const outside = join(home, "outside"); await mkdir(outside);
  await symlink(outside, join(home, "plugin-secrets"));
  await assert.rejects(new SecretStore(home).save("secret"), { code: "secret_storage_failed" });
});
test("background task owns cancellation, deduplicates and does not re-run after finish", async () => {
  const owner = new TaskOwner(); let count = 0; let cancelled = false;
  assert.equal(owner.start("workspace", async (signal) => {
    count++;
    try { await abortable(new Promise(() => {}), signal); } catch { cancelled = true; }
  }), true);
  assert.equal(owner.start("workspace", async () => { count++; }), false);
  await delay(0); owner.cancel("workspace"); await owner.stop();
  assert.equal(count, 1); assert.equal(cancelled, true);
  assert.equal(owner.start("workspace", async () => {}), false);
});
test("already-cancelled operations consume later promise rejection", async () => {
  const abort = new AbortController(); abort.abort(new PinError("cancelled"));
  const operation = delay(5).then(() => { throw new Error("late rejection"); });
  await assert.rejects(abortable(operation, abort.signal), { code: "cancelled" });
  await delay(15);
});
test("deadline terminates hanging tasks", async () => {
  const owner = new TaskOwner(); let reason;
  owner.start("timeout", async (signal) => { try { await abortable(new Promise(() => {}), signal); } catch (error) { reason = (error as PinError).code; } }, 10);
  await delay(30); await owner.stop(); assert.equal(reason, "timeout");
});
