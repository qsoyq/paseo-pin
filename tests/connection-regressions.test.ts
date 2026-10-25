import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { DaemonConnector } from "../server/daemon.ts";
import { PinError } from "../server/errors.ts";
import { settingsSchema } from "../shared/settings.ts";

async function homeFor(t: TestContext) {
  // Short paths stay within the macOS Unix socket path limit.
  const home = await mkdtemp("/tmp/pin-regression-");
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, "server-id"), "srv_regression");
  await writeFile(join(home, "local-credential"), "synthetic-token");
  await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:1" } }));
  return home;
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation did not settle promptly")), 1000);
    })]);
  } finally { clearTimeout(timer!); }
}

test("automatic and fallback connections authenticate through the actual Unix socket", { skip: process.platform === "win32" }, async (t) => {
  const home = await homeFor(t);
  const socketPath = join(home, "daemon:#.sock");
  const server = createServer();
  const ws = new WebSocketServer({ server });
  t.after(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((done) => ws.close(() => done()));
    await new Promise<void>((done) => server.close(() => done()));
  });
  const requests: string[] = [];
  ws.on("connection", (client, request) => {
    requests.push(request.url!);
    client.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "hello") return;
      assert.deepEqual(message.auth, { kind: "localCredential", token: "synthetic-token" });
      client.send(JSON.stringify({ type: "session", message: { type: "status", payload: {
        status: "server_info", serverId: "srv_regression", hostname: "test", version: "0.12.0",
      } } }));
    });
  });
  server.listen(socketPath); await once(server, "listening");
  const connector = new DaemonConnector(home, {});
  const settings = settingsSchema.parse({ fallbackEnabled: true, credentialSource: "file", fileKind: "localCredential", filePath: join(home, "local-credential") });
  for (const listen of [socketPath, `unix://${socketPath}`]) {
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen } }));
    for (const route of ["automatic", "fallback"] as const) {
      const client = await connector.connect(route, settings, AbortSignal.timeout(2000));
      try { assert.equal(client.getLastServerInfoMessage()?.serverId, "srv_regression"); }
      finally { await client.close(); }
    }
  }
  assert.deepEqual(requests, ["/ws", "/ws", "/ws", "/ws"]);
});

for (const stage of ["identity", "target", "credential"] as const) {
  for (const reason of ["cancelled", "timeout"] as const) {
    test(`${reason} interrupts pending ${stage} I/O before any connection is opened`, async (t) => {
      const connector = new DaemonConnector(await homeFor(t), {});
      let start!: () => void;
      let fail!: (error: Error) => void;
      const started = new Promise<void>((resolve) => { start = resolve; });
      const pending = new Promise<never>((_, reject) => { fail = reject; });
      let targetCalls = 0;
      const blocked = () => { start(); return pending; };
      // Hold each asynchronous I/O boundary without relying on a slow filesystem.
      if (stage === "identity") {
        t.mock.method(connector, "identity", blocked);
        t.mock.method(connector, "automaticTarget", () => { targetCalls++; throw new Error("unexpected discovery"); });
      } else if (stage === "target") t.mock.method(connector, "automaticTarget", blocked);
      else t.mock.method(connector.secrets, "read", blocked);
      const controller = new AbortController();
      const settings = settingsSchema.parse({ fallbackEnabled: true, credentialSource: "literal" });
      const connecting = connector.connect(stage === "credential" ? "fallback" : "automatic", settings, controller.signal);
      const rejected = assert.rejects(connecting, { code: reason });
      try {
        await bounded(started);
        controller.abort(new PinError(reason));
        await bounded(rejected);
      } finally {
        // Late I/O errors must be consumed, even after the caller has returned.
        fail(new PinError(reason));
        await rejected;
      }
      assert.equal(targetCalls, 0);
    });
  }
}

function probeFifo(home: string, operation: string) {
  // A blocking filesystem call cannot reliably be cancelled in-process. Own it
  // in a child so even a broken implementation cannot keep the test runner alive.
  return spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), "--input-type=module", "--eval",
    `import assert from "node:assert/strict";
     import { DaemonConnector } from ${JSON.stringify(new URL("../server/daemon.ts", import.meta.url).href)};
     const connector = new DaemonConnector(process.argv[1], {});
     console.log("FIFO probe started");
     await assert.rejects(${operation}, { code: "home_unavailable" });`,
    home,
  ], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
}

for (const filename of ["server-id", "paseo.pid", "config.json"]) {
  test(`rejects a FIFO used as ${filename} without waiting for a writer`, { skip: process.platform === "win32" }, async (t) => {
    const home = await homeFor(t);
    const path = join(home, filename);
    await rm(path, { force: true });
    execFileSync("mkfifo", [path]);
    const result = probeFifo(home, filename === "server-id" ? "connector.identity()" : "connector.automaticTarget()");
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

for (const operation of ["Promise.resolve('unexpected-success')", "Promise.reject(new Error('unexpected-error'))"]) {
  test(`FIFO probe reports an assertion failure without hanging: ${operation}`, async (t) => {
    const result = probeFifo(await homeFor(t), operation);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AssertionError/);
  });
}

test("FIFO probe terminates a child blocked on a real FIFO read", { skip: process.platform === "win32" }, async (t) => {
  const home = await homeFor(t);
  execFileSync("mkfifo", [join(home, "blocked")]);
  const result = probeFifo(home, "import('node:fs/promises').then(fs => fs.readFile(process.argv[1] + '/blocked', 'utf8'))");
  assert.match(result.stdout, /FIFO probe started/);
  assert(result.error && "code" in result.error);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGKILL");
});
