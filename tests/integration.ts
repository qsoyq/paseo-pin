import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import WebSocket from "ws";
import { settingsSchema } from "../shared/settings.ts";
import { DaemonConnector } from "../server/daemon.ts";
import { pinOnce } from "../server/pin.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.env.PIN_TEST_CLI || "/tmp/paseo-pin-runtime/node_modules/@getpaseo/cli/bin/paseo";
const legacy = process.env.PIN_TEST_LEGACY === "1";
const root = await mkdtemp(join(tmpdir(), "pin-integration-"));
const password = `test-${randomUUID()}`;
const secrets = [password];
let daemonLog = "";
let client: DaemonClient | undefined;
let child: ReturnType<typeof spawn> | undefined;
const completed: string[] = [];
async function waitFor<T>(check: () => Promise<T | null | false | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result;
    if (child && child.exitCode !== null) throw new Error(`daemon exited: ${child.exitCode}`);
    await delay(100);
  }
  throw new Error("condition deadline exceeded");
}
async function port() {
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address(); assert(address && typeof address === "object");
  await new Promise<void>((done) => socket.close(() => done())); return address.port;
}
const rpc = async (method: string, input: unknown = {}) => client!.invokePluginRpc("paseo-pin", method, input) as Promise<any>;
async function saveSettings(values: unknown) {
  const state = await rpc("settings.connection.read");
  const result = await rpc("settings.connection.write", { revision: state.revision, values });
  assert.equal(result.status, "saved");
}
async function workspace(label: string, background = false) {
  const path = join(root, label); await mkdir(path);
  const result = await client!.createWorkspace({ source: { kind: "directory", path }, title: label, ...(legacy ? {} : { background }) });
  assert(result.workspace); return result.workspace.id;
}
async function current(id: string) {
  return (await client!.fetchWorkspaces({ filter: { idPrefix: id, ...(legacy ? {} : { includeBackground: true }) } })).entries.find((item) => item.id === id);
}
async function jsonFiles(path: string): Promise<string> {
  let result = "";
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) result += await jsonFiles(target);
    else result += await readFile(target, "utf8").catch(() => "");
  }
  return result;
}
try {
  const listen = `127.0.0.1:${await port()}`;
  const home = join(root, "home"); await mkdir(home);
  await writeFile(join(home, "config.json"), JSON.stringify({
    version: 1, pluginsEnabled: true, daemon: { listen, relay: { enabled: false }, mcp: { injectIntoAgents: false } },
    agents: { providers: Object.fromEntries(["claude", "codex", "pi", "opencode", "omp"].map((id) => [id, { enabled: false }])) },
    features: { dictation: { enabled: false }, voiceMode: { enabled: false }, webUi: { enabled: Boolean(process.env.PIN_TEST_BROWSER) } },
  }));
  // Only a minimal environment is inherited. Never copy real provider credentials or daemon state.
  child = spawn(process.execPath, [runtime, "daemon", "run", "--home", home], {
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), PASEO_HOME: home, PASEO_LISTEN: listen, PASEO_PASSWORD: password, PIN_TEST_PASSWORD: password, PASEO_LOCAL: "1" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  child.stdout!.on("data", (data) => { daemonLog += data.toString(); });
  child.stderr!.on("data", (data) => { daemonLog += data.toString(); });
  await waitFor(async () => { try { return (await readFile(join(home, "server-id"), "utf8")).trim(); } catch { return null; } }, 30_000);
  client = await waitFor(async () => {
    const candidate = new DaemonClient({ url: `ws://${listen}/ws`, clientId: "pin-integration", clientType: "cli", password, reconnect: { enabled: false }, connectTimeoutMs: 2_000, logger: { debug() {}, info() {}, warn() {}, error() {} }, webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike });
    try { await candidate.connect(); return candidate; } catch { await candidate.close(); return null; }
  }, 30_000);
  const old = await workspace("before-install");
  const installed = await client.installDirectoryPlugin(process.env.PIN_PLUGIN_DIRECTORY || repository);
  assert.equal(installed.status, "running", JSON.stringify(installed));
  completed.push("real plugin builds, starts, and registers settings/RPCs");
  assert.equal((await current(old))?.pinnedAt ?? null, null);
  if (legacy) {
    await saveSettings(settingsSchema.parse({ fallbackEnabled: true, credentialSource: "environment", environmentName: "PIN_TEST_PASSWORD" }));
    assert.equal((await rpc("connection.test", { route: "automatic" })).error, "credential_unavailable");
    assert.equal((await rpc("connection.test", { route: "fallback" })).ok, true);
  } else assert.equal((await rpc("connection.test", { route: "automatic" })).ok, true);
  const first = await workspace("automatic-auth");
  await waitFor(async () => (await current(first))?.pinnedAt);
  await client.setWorkspacePinned(first, false);
  await delay(300);
  await client.reloadPlugin("paseo-pin");
  await delay(300);
  assert.equal((await current(first))?.pinnedAt ?? null, null);
  assert.equal((await current(old))?.pinnedAt ?? null, null);
  completed.push(legacy ? "legacy password fallback pins only new workspaces; unpin survives reload" : "password-protected daemon: automatic credential pins only new workspaces; unpin survives reload");

  const defaults = settingsSchema.parse({ fallbackEnabled: true, endpoint: `ws://${listen}/ws` });
  await saveSettings({ ...defaults, credentialSource: "literal" });
  assert.equal((await rpc("credential.store", { password })).ok, true);
  assert.deepEqual(await rpc("credential.status"), { stored: true });
  assert.equal((await rpc("connection.test", { route: "fallback" })).ok, true);
  assert(!JSON.stringify(await rpc("settings.connection.read")).includes(password));
  assert.equal((await rpc("credential.store", { password: { nested: password } })).ok, false);
  assert.equal((await rpc("credential.store", { password: `${password}\ninvalid` })).ok, false);
  completed.push("literal password: private store, write-only RPC, invalid input redaction");

  await saveSettings({ ...defaults, credentialSource: "environment", environmentName: "PIN_TEST_PASSWORD" });
  assert.equal((await rpc("connection.test", { route: "fallback" })).ok, true);
  await saveSettings({ ...defaults, credentialSource: "environment", environmentName: "PIN_MISSING" });
  assert.equal((await rpc("connection.test", { route: "fallback" })).error, "environment_missing");
  completed.push("environment password success and missing-variable failure");

  const passwordPath = join(home, "test-password"); await writeFile(passwordPath, `${password}\n`, { mode: 0o600 });
  await saveSettings({ ...defaults, credentialSource: "file", filePath: passwordPath });
  assert.equal((await rpc("connection.test", { route: "fallback" })).ok, true);
  await writeFile(passwordPath, "wrong-password");
  assert.equal((await rpc("connection.test", { route: "fallback" })).error, "connection_failed");
  await writeFile(passwordPath, password);
  assert.equal((await rpc("connection.test", { route: "fallback" })).ok, true);
  const tokenPath = join(home, "saved-token");
  if (!legacy) {
    await copyFile(join(home, "local-credential"), tokenPath);
    const token = (await readFile(tokenPath, "utf8")).trim(); secrets.push(token);
    await saveSettings({ ...defaults, credentialSource: "file", filePath: tokenPath, fileKind: "localCredential" });
    assert.equal((await rpc("connection.test", { route: "fallback" })).ok, true);
    // Remove only the isolated daemon's credential file. Its in-memory token remains valid.
    await rm(join(home, "local-credential"));
  }
  completed.push(legacy ? "legacy file password and rotation passed; localCredential unavailable on this host" : "file password/localCredential success, bad password failure, file rotation without reload");
  for (const values of [
    { ...defaults, credentialSource: "literal" },
    { ...defaults, credentialSource: "environment", environmentName: "PIN_TEST_PASSWORD" },
    { ...defaults, credentialSource: "file", filePath: passwordPath },
    ...(!legacy ? [{ ...defaults, credentialSource: "file", filePath: tokenPath, fileKind: "localCredential" }] : []),
  ]) {
    await saveSettings(values);
    const id = await workspace(`fallback-${values.credentialSource}-${"fileKind" in values ? values.fileKind : "password"}-${completed.length}`);
    await waitFor(async () => (await current(id))?.pinnedAt);
    completed.push(`live workspace pins through fallback: ${values.credentialSource}/${"fileKind" in values ? values.fileKind : "password"}`);
  }
  if (!legacy) await copyFile(tokenPath, join(home, "local-credential"));
  const snapshotBeforeTest = (await client.fetchWorkspaces()).entries.map(({ id, pinnedAt }) => ({ id, pinnedAt }));
  assert.equal((await rpc("connection.test", { route: "fallback" })).ok, true);
  assert.deepEqual((await client.fetchWorkspaces()).entries.map(({ id, pinnedAt }) => ({ id, pinnedAt })), snapshotBeforeTest);
  completed.push("connection test has no workspace mutations");

  const wrongHome = join(root, "wrong-home"); await mkdir(wrongHome);
  await writeFile(join(wrongHome, "server-id"), "srv_wrong");
  const wrong = new DaemonConnector(wrongHome, { PIN_TEST_PASSWORD: password });
  await assert.rejects(wrong.connect("fallback", { ...defaults, credentialSource: "environment", environmentName: "PIN_TEST_PASSWORD" }, AbortSignal.timeout(6_000)), { code: "wrong_daemon" });
  const connector = new DaemonConnector(home, { PASEO_PASSWORD: password, PIN_TEST_PASSWORD: password });
  const inspectionSettings = legacy ? { ...defaults, credentialSource: "environment" as const, environmentName: "PIN_TEST_PASSWORD" } : defaults;
  const already = await current(first);
  await client.setWorkspacePinned(first, true);
  const pin = (await current(first))!.pinnedAt;
  assert.equal((await pinOnce(connector, inspectionSettings, first, AbortSignal.timeout(6_000))).outcome, "already_pinned");
  assert.equal((await current(first))!.pinnedAt, pin);
  assert(already);
  completed.push("wrong daemon rejected; already-pinned timestamp preserved");
  const concurrent = await Promise.all(Array.from({ length: 5 }, (_, i) => workspace(`concurrent-${i}`)));
  await Promise.all(concurrent.map((id) => waitFor(async () => (await current(id))?.pinnedAt)));
  completed.push("five simultaneous creations use independent client sessions and all pin");
  if (!legacy) {
    const background = await workspace("background", true);
    await waitFor(async () => (await current(background))?.pinnedAt);
    completed.push("public background workspaces are pinned too");
  }
  const archived = await workspace("archived");
  await client.archiveWorkspace(archived);
  assert.equal((await pinOnce(connector, inspectionSettings, archived, AbortSignal.timeout(6_000))).outcome, "skipped");
  completed.push("archived or missing workspace is skipped");

  if (process.env.PIN_TEST_BROWSER) {
    const browserModule = resolve(repository, "tests/browser.mjs");
    const { verifySettings } = await import(browserModule);
    await verifySettings({ url: `http://${listen}`, password, serverId: client.getLastServerInfoMessage()!.serverId, legacy });
    completed.push("settings page rendered and exercised in real browser");
  }
  assert.equal((await rpc("credential.delete")).ok, true);
  assert.deepEqual(await rpc("credential.status"), { stored: false });
  const logs = JSON.stringify(await client.getPluginLogs("paseo-pin"));
  const settingsFiles = await jsonFiles(join(home, "plugin-settings"));
  for (const secret of secrets) {
    assert(!logs.includes(secret), "plugin logs contain secret");
    assert(!daemonLog.includes(secret), "daemon stdout contains secret");
    assert(!settingsFiles.includes(secret), "ordinary settings contain secret");
    const daemonFile = await readFile(join(home, "daemon.log"), "utf8").catch(() => "");
    assert(!daemonFile.includes(secret), "daemon log contains secret");
  }
  completed.push("secret deletion and no plaintext secrets in ordinary settings or logs");
  await client.disablePlugin("paseo-pin");
  const disabled = await workspace("disabled"); await delay(250);
  assert.equal((await current(disabled))?.pinnedAt ?? null, null);
  completed.push("disabled plugin does not pin");
  console.log(JSON.stringify({ ok: true, runtimeCli: runtime, checks: completed }, null, 2));
} catch (error) {
  let safeLog = daemonLog.slice(-12_000);
  for (const secret of secrets) safeLog = safeLog.replaceAll(secret, "[REDACTED]");
  console.error(safeLog);
  console.error("Completed checks:", completed);
  throw error;
} finally {
  await client?.close();
  if (child?.pid && child.exitCode === null) {
    const exited = once(child, "exit");
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  }
  if (process.env.PIN_KEEP_TEST_HOME) console.log(`Test home retained: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
