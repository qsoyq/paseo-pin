import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import WebSocket from "ws";
import type { ConnectionSettings } from "../shared/settings.ts";
import { expandFilePath, readSecretFile, resolveCredential, SecretStore, type Credential } from "./credentials.ts";
import { abortable, checkSignal, PinError } from "./errors.ts";

export type Target = { url: string; local: boolean; socketPath?: string };
export function parseTarget(value: string, automatic = false): Target {
  if (automatic && (isAbsolute(value) || value.startsWith("unix://"))) {
    const socketPath = value.startsWith("unix://") ? value.slice(7) : value;
    if (!isAbsolute(socketPath)) throw new PinError("endpoint_invalid");
    return { url: "ws://localhost/ws", socketPath, local: true };
  }
  try {
    const url = new URL(automatic && !value.includes("://") ? `ws://${value}/ws` : value);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/ws") throw new Error();
    if (automatic && url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (automatic && url.hostname === "[::]") url.hostname = "[::1]";
    // Use literals only, avoiding DNS rebinding and ambiguous localhost resolution.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    const local = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!local && url.protocol !== "wss:") throw new PinError("insecure_endpoint");
    return { url: url.href, local };
  } catch (error) { if (error instanceof PinError) throw error; throw new PinError("endpoint_invalid"); }
}
export function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.PASEO_HOME || join(homedir(), ".paseo");
  return resolve(expandFilePath(home));
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
async function readMetadata(path: string): Promise<string> {
  // Opening a FIFO must not occupy a worker while waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new PinError("home_unavailable");
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return record(JSON.parse(await readMetadata(path))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new PinError("home_unavailable"); }
}
export class DaemonConnector {
  readonly secrets: SecretStore;
  constructor(readonly home = paseoHome(), private readonly env: NodeJS.ProcessEnv = process.env) { this.secrets = new SecretStore(home); }
  async identity(): Promise<string> {
    try { const id = this.env.PASEO_SERVER_ID?.trim() || (await readMetadata(join(this.home, "server-id"))).trim(); if (!id || id.length > 256) throw new Error(); return id; }
    catch { throw new PinError("home_unavailable"); }
  }
  async automaticTarget(): Promise<Target> {
    const [pid, config] = await Promise.all([readJson(join(this.home, "paseo.pid")), readJson(join(this.home, "config.json"))]);
    const listen = pid?.listen ?? this.env.PASEO_LISTEN ?? record(config?.daemon)?.listen;
    if (typeof listen !== "string" || !listen) throw new PinError("home_unavailable");
    const target = parseTarget(listen, true);
    if (!target.local) throw new PinError("insecure_endpoint");
    return target;
  }
  async connect(route: "automatic" | "fallback", settings: ConnectionSettings, signal: AbortSignal): Promise<DaemonClient> {
    checkSignal(signal);
    // Bound each pre-connect stage, so cancellation cannot resume into a new socket.
    const expectedId = await abortable(this.identity(), signal);
    if (route === "fallback" && !settings.fallbackEnabled) throw new PinError("fallback_disabled");
    const target = route === "fallback" && settings.endpoint.trim() ? parseTarget(settings.endpoint.trim()) : await abortable(this.automaticTarget(), signal);
    let credential: Credential | undefined;
    if (route === "automatic") {
      const credentialPath = join(this.home, "local-credential");
      let missing = false;
      try { await abortable(lstat(credentialPath), signal); }
      catch (error) {
        if (error instanceof PinError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PinError("credential_unavailable");
        missing = true;
      }
      if (!missing) credential = { kind: "localCredential", value: await abortable(readSecretFile(credentialPath), signal) };
      else {
        // 0.9.1 predates local credentials. Never silently discard a bad credential
        // or configured authentication; password-protected old hosts use fallback.
        const config = await abortable(readJson(join(this.home, "config.json")), signal);
        if (!config || this.env.PASEO_PASSWORD?.trim() || record(record(config.daemon)?.auth)?.password) {
          throw new PinError("credential_unavailable");
        }
      }
    } else credential = await abortable(resolveCredential(settings, this.secrets, this.env), signal);
    if (credential?.kind === "localCredential" && !target.local) throw new PinError("insecure_endpoint");
    checkSignal(signal);
    const client = new DaemonClient({
      url: target.url, clientId: `paseo-pin-${randomUUID()}`, clientType: "cli",
      ...(credential?.kind === "password" ? { password: credential.value } : credential ? { localCredential: () => credential.value } : {}),
      connectTimeoutMs: 5_000, reconnect: { enabled: false },
      // Silence SDK diagnostics: only our fixed, secret-free error codes reach logs.
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, {
        headers: options?.headers,
        // ws overwrites socketPath options. Supply the transport explicitly and
        // keep the filesystem path out of URL parsing (paths may contain :/#).
        ...(target.socketPath ? { createConnection: () => createConnection({ path: target.socketPath! }) } : {}),
        followRedirects: false,
      }) as unknown as WebSocketLike,
    });
    try {
      await abortable(client.connect(), signal);
      checkSignal(signal);
      if (client.getLastServerInfoMessage()?.serverId !== expectedId) throw new PinError("wrong_daemon");
      return client;
    } catch (error) {
      await client.close();
      if (error instanceof PinError) throw error;
      throw new PinError("connection_failed");
    }
  }
}
