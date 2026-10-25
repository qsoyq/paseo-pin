import type { PluginServerContext } from "@getpaseo/plugin/server";
import { connectionSettings } from "./shared/settings.ts";
import { credentialStatus, deletePassword, storePassword, testConnection } from "./shared/rpc.ts";
import { DaemonConnector } from "./server/daemon.ts";
import { abortable, errorCode, PinError } from "./server/errors.ts";
import { pinOnce, TaskOwner } from "./server/pin.ts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(connectionSettings);
  const connector = new DaemonConnector();
  const tasks = new TaskOwner();
  const lifetime = new AbortController();
  const rpcTasks = new Set<Promise<unknown>>();
  let stopped = false;
  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    if (stopped) throw new PinError("cancelled");
    const operation = action(); rpcTasks.add(operation);
    try { return await operation; } finally { rpcTasks.delete(operation); }
  }
  server.handle(credentialStatus, async () => ({ stored: !stopped && await connector.secrets.stored() }));
  server.handle(storePassword, async (input) => {
    try {
      await guarded(async () => {
        const password = input && typeof input === "object" && "password" in input ? input.password : undefined;
        await connector.secrets.save(password);
      });
      return { ok: true };
    } catch (error) { return { ok: false, error: errorCode(error) }; }
  });
  server.handle(deletePassword, async () => {
    try { await guarded(() => connector.secrets.delete()); return { ok: true }; }
    catch (error) { return { ok: false, error: errorCode(error) }; }
  });
  server.handle(testConnection, async ({ route }) => {
    try {
      return await guarded(async () => {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new PinError("timeout")), 10_000);
        const signal = AbortSignal.any([lifetime.signal, timeout.signal]);
        try {
          const state = await abortable(settings.read(), signal);
          if (state.status !== "ready") throw new PinError("settings_invalid");
          const client = await connector.connect(route, state.values, signal);
          try { return { ok: true, route, serverId: client.getLastServerInfoMessage()!.serverId }; }
          finally { await client.close(); }
        } finally { clearTimeout(timer); }
      });
    } catch (error) { return { ok: false, error: errorCode(error) }; }
  });
  const removeCreated = server.on("workspace.created", ({ workspace }, context) => {
    if (stopped || context.signal.aborted || workspace.archivedAt) return;
    tasks.start(workspace.id, async (signal) => {
      try {
        const state = await abortable(settings.read(), signal);
        if (state.status !== "ready") throw new PinError("settings_invalid");
        const result = await pinOnce(connector, state.values, workspace.id, signal);
        console.log(JSON.stringify({ plugin: "paseo-pin", workspaceId: workspace.id, ...result }));
      } catch (error) {
        console.error(JSON.stringify({ plugin: "paseo-pin", workspaceId: workspace.id, outcome: "failed", error: errorCode(error) }));
      }
    });
  });
  const removeArchived = server.on("workspace.archived", ({ workspace }) => tasks.cancel(workspace.id));
  return async () => {
    stopped = true; lifetime.abort(new PinError("cancelled"));
    removeCreated(); removeArchived();
    await Promise.allSettled([tasks.stop(), ...rpcTasks]);
  };
}
