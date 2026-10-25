import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { DaemonConnector } from "../server/daemon.ts";
import { settingsSchema } from "../shared/settings.ts";
import { pinOnce } from "../server/pin.ts";
import { PinError } from "../server/errors.ts";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "pin-wire-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "server-id"), "srv_wiretest");
  await writeFile(join(home, "local-credential"), "synthetic-test-token");
  return home;
}
test("cancelling during a stalled handshake closes the socket promptly", async (t) => {
  const home = await fixture(t);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("data", () => {}); socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); assert(address && typeof address === "object");
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: `127.0.0.1:${address.port}` } }));
  const abort = new AbortController();
  const connecting = new DaemonConnector(home, {}).connect("automatic", settingsSchema.parse({}), abort.signal);
  await delay(80); assert.equal(sockets.size, 1);
  abort.abort(new PinError("cancelled"));
  await assert.rejects(connecting, { code: "cancelled" });
  await delay(80); assert.equal(sockets.size, 0);
});

test("lost pin acknowledgement never retries on fallback or repeats the mutation", async (t) => {
  const home = await fixture(t);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address(); assert(address && typeof address === "object");
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: `127.0.0.1:${address.port}` } }));
  let pins = 0; let connections = 0;
  server.on("connection", (socket: WebSocket) => {
    connections++;
    socket.on("message", (data) => {
      const envelope = JSON.parse(data.toString());
      if (envelope.type === "hello") {
        socket.send(JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", serverId: "srv_wiretest", hostname: "test", version: "0.12.0", features: { backgroundWorkspaces: true, workspaceMultiplicity: true } } } }));
      }
      const message = envelope.type === "session" ? envelope.message : envelope;
      if (message?.type === "fetch_workspaces_request") {
        socket.send(JSON.stringify({ type: "session", message: { type: "fetch_workspaces_response", payload: { requestId: message.requestId, entries: [{ id: "wks_test", projectId: "prj_test", projectDisplayName: "test", projectRootPath: "/tmp", projectKind: "directory", workspaceKind: "directory", name: "test", status: "done", activityAt: null, pinnedAt: null }], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } } } }));
      }
      if (message?.type === "workspace.pin.set.request") { pins++; socket.terminate(); }
    });
  });
  const connector = new DaemonConnector(home, { TEST_PASSWORD: "synthetic-test-password" });
  await assert.rejects(pinOnce(connector, settingsSchema.parse({ fallbackEnabled: true, credentialSource: "environment", environmentName: "TEST_PASSWORD" }), "wks_test", AbortSignal.timeout(3_000)), { code: "pin_unknown" });
  assert.equal(pins, 1); assert.equal(connections, 1);
});
