import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { DaemonConnector } from "../server/daemon.ts";
import { pinOnce } from "../server/pin.ts";
import { settingsSchema } from "../shared/settings.ts";

const manifest = JSON.parse(await readFile(new URL("../paseo-plugin.json", import.meta.url), "utf8"));
test("version requirement matches loom minimum without excluding stable 0.13 clients", () => {
  assert.equal(manifest.requirements.paseo, ">=0.9.1");
  // 0.9.1 rejects unknown manifest keys; name falls back to the plugin ID.
  assert.equal("name" in manifest, false);
  assert.equal(manifest.id, "paseo-pin");
  for (const runtime of ["app", "daemon"] as const) {
    for (const version of ["0.9.1", "0.12.0-beta.3", "0.12.0", "0.13.0-beta.2", "0.13.0", "0.13.1"]) {
      assert.doesNotThrow(() => assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, runtime, version }));
    }
    assert.throws(() => assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, runtime, version: "0.9.0" }));
  }
});
test("legacy host without local credential connects anonymously only when authentication is not configured", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pin-legacy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); assert(address && typeof address === "object");
  const config = { daemon: { listen: `127.0.0.1:${address.port}` } };
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  await writeFile(join(home, "server-id"), "srv_legacy");
  let pins = 0; let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    socket.on("message", (data) => {
      const envelope = JSON.parse(data.toString());
      if (envelope.type === "hello") {
        assert.equal(envelope.auth, undefined);
        socket.send(JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", serverId: "srv_legacy", version: "0.9.1", features: { workspaceMultiplicity: true } } } }));
      }
      const message = envelope.message;
      if (message?.type === "fetch_workspaces_request") {
        assert.equal(message.filter.includeBackground, undefined);
        socket.send(JSON.stringify({ type: "session", message: { type: "fetch_workspaces_response", payload: { requestId: message.requestId, entries: [{ id: "wks_test", projectId: "prj_test", projectDisplayName: "test", projectRootPath: "/tmp", projectKind: "directory", workspaceKind: "directory", name: "test", status: "done", activityAt: null, pinnedAt: null }], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } } } }));
      }
      if (message?.type === "workspace.pin.set.request") {
        pins++;
        socket.send(JSON.stringify({ type: "session", message: { type: "workspace.pin.set.response", payload: { requestId: message.requestId, workspaceId: "wks_test", accepted: true, pinnedAt: new Date().toISOString(), error: null } } }));
      }
    });
  });
  const defaults = settingsSchema.parse({});
  const connector = new DaemonConnector(home, {});
  assert.equal((await pinOnce(connector, defaults, "wks_test", AbortSignal.timeout(3000))).outcome, "pinned");
  assert.equal(pins, 1);
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { ...config.daemon, auth: { password: "hash" } } }));
  await assert.rejects(connector.connect("automatic", defaults, AbortSignal.timeout(3000)), { code: "credential_unavailable" });
  await writeFile(join(home, "config.json"), JSON.stringify(config));
  await assert.rejects(new DaemonConnector(home, { PASEO_PASSWORD: "set" }).connect("automatic", defaults, AbortSignal.timeout(3000)), { code: "credential_unavailable" });
  await writeFile(join(home, "local-credential"), "");
  await assert.rejects(connector.connect("automatic", defaults, AbortSignal.timeout(3000)), { code: "credential_unavailable" });
  assert.equal(connections, 1, "invalid/missing configured credentials must not downgrade to anonymous");
});
