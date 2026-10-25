import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ConnectionSettings } from "../shared/settings.ts";
import { DaemonConnector } from "./daemon.ts";
import { abortable, checkSignal, PinError } from "./errors.ts";

export async function pinOnce(connector: DaemonConnector, settings: ConnectionSettings, workspaceId: string, signal: AbortSignal) {
  let client: DaemonClient;
  let route: "automatic" | "fallback" = "automatic";
  try { client = await connector.connect("automatic", settings, signal); }
  catch (error) {
    checkSignal(signal);
    // Wrong identity is not a transient connection failure. Never continue on it.
    if (!settings.fallbackEnabled || (error instanceof PinError && error.code === "wrong_daemon")) throw error;
    route = "fallback";
    client = await connector.connect("fallback", settings, signal);
  }
  try {
    checkSignal(signal);
    const includeBackground = client.getLastServerInfoMessage()?.features?.backgroundWorkspaces === true;
    const result = await abortable(client.fetchWorkspaces({ filter: { idPrefix: workspaceId, ...(includeBackground ? { includeBackground: true } : {}) } }), signal);
    const workspace = result.entries.find((item) => item.id === workspaceId);
    if (!workspace || workspace.archivingAt) return { outcome: "skipped", route };
    if (workspace.pinnedAt) return { outcome: "already_pinned", route };
    checkSignal(signal);
    try { await abortable(client.setWorkspacePinned(workspaceId, true), signal); }
    catch { throw new PinError("pin_unknown"); }
    return { outcome: "pinned", route };
  } finally { await client.close(); }
}

/** Own background work independently of the short-lived lifecycle callback. */
export class TaskOwner {
  private stopped = false;
  private readonly seen = new Set<string>();
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  start(key: string, task: (signal: AbortSignal) => Promise<void>, timeoutMs = 10_000): boolean {
    if (this.stopped || this.seen.has(key)) return false;
    this.seen.add(key);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new PinError("timeout")), timeoutMs);
    const promise = Promise.resolve().then(() => task(abort.signal)).finally(() => {
      clearTimeout(timer); this.active.delete(key);
    });
    this.active.set(key, { abort, promise });
    // Tasks log their own result. This catch is a final teardown-safe rejection sink.
    void promise.catch(() => {});
    return true;
  }
  cancel(key: string) { this.active.get(key)?.abort.abort(new PinError("cancelled")); }
  async stop() {
    this.stopped = true;
    for (const { abort } of this.active.values()) abort.abort(new PinError("cancelled"));
    await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
    this.seen.clear();
  }
}
