import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConnectionSettings } from "../shared/settings.ts";
import { PinError } from "./errors.ts";

const MAX_SECRET_BYTES = 16_384;
export function validateSecret(value: unknown): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > MAX_SECRET_BYTES || /[\r\n\0]/.test(value)) {
    throw new PinError("credential_unavailable");
  }
  return value;
}
export function expandFilePath(path: string, userHome = homedir()): string {
  const expanded = path.startsWith("~/") ? join(userHome, path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new PinError("credential_unavailable");
  return expanded;
}
export async function readSecretFile(path: string): Promise<string> {
  let file;
  try {
    // Nonblocking open prevents FIFOs from hanging; final symlinks are rejected.
    file = await open(expandFilePath(path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SECRET_BYTES + 2) throw new Error();
    const buffer = Buffer.alloc(MAX_SECRET_BYTES + 3);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SECRET_BYTES + 2) throw new Error();
    return validateSecret(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)).replace(/\r?\n$/, ""));
  } catch { throw new PinError("credential_unavailable"); }
  finally { await file?.close(); }
}
export class SecretStore {
  readonly directory: string;
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(home: string) {
    this.directory = join(home, "plugin-secrets", "paseo-pin");
    this.path = join(this.directory, "password");
  }
  private async prepare() {
    if (process.platform === "win32") throw new PinError("secret_storage_failed");
    for (const dir of [join(this.directory, ".."), this.directory]) {
      await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error();
      await chmod(dir, 0o700);
    }
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }
  async stored(): Promise<boolean> {
    try { await this.read(); return true; } catch { return false; }
  }
  async read(): Promise<string> {
    try {
      const stat = await lstat(this.path);
      if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error();
      return await readSecretFile(this.path);
    } catch { throw new PinError("credential_unavailable"); }
  }
  save(value: unknown): Promise<void> {
    return this.serialize(async () => {
      const secret = validateSecret(value);
      let temporary: string | undefined;
      try {
        await this.prepare();
        temporary = join(this.directory, `${randomUUID()}.tmp`);
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(secret, "utf8"); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
      } catch { throw new PinError("secret_storage_failed"); }
      finally { if (temporary) await unlink(temporary).catch(() => {}); }
    });
  }
  delete(): Promise<void> {
    return this.serialize(async () => {
      try { await this.prepare(); await unlink(this.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; }); }
      catch { throw new PinError("secret_storage_failed"); }
    });
  }
}
export type Credential = { kind: "password" | "localCredential"; value: string };
export async function resolveCredential(settings: ConnectionSettings, store: SecretStore, env: NodeJS.ProcessEnv = process.env): Promise<Credential> {
  switch (settings.credentialSource) {
    case "literal": return { kind: "password", value: await store.read() };
    case "environment": {
      const value = env[settings.environmentName];
      if (!value) throw new PinError("environment_missing");
      return { kind: "password", value: validateSecret(value) };
    }
    case "file": return { kind: settings.fileKind, value: await readSecretFile(settings.filePath) };
  }
}
