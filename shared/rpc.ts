import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const errorMessages = {
  home_unavailable: "无法确认插件所属 daemon 的目录或身份。",
  endpoint_invalid: "地址无效，请填写 ws:// 或 wss:// 地址并包含 /ws。",
  insecure_endpoint: "非回环地址必须使用 wss://，本地凭据仅允许本机连接。",
  credential_unavailable: "凭据不存在、为空、不可读或格式无效。",
  secret_storage_failed: "私有密码保存失败，请检查 daemon 主机的目录权限。",
  environment_missing: "插件进程中找不到该环境变量，或变量为空。",
  settings_invalid: "配置无效，请重新保存。",
  fallback_disabled: "尚未启用连接兜底。",
  connection_failed: "连接或认证失败，请检查地址和凭据。",
  wrong_daemon: "连接到了不同的 daemon，已拒绝操作。",
  timeout: "操作超时，未自动重试。",
  cancelled: "操作已取消。",
  pin_unknown: "置顶请求结果未知，未重试；请查看 workspace 当前状态。",
  unavailable: "插件正在停止或操作失败。",
} as const;
export const errorCodeSchema = z.enum(Object.keys(errorMessages) as [keyof typeof errorMessages, ...(keyof typeof errorMessages)[]]);
export type ErrorCode = keyof typeof errorMessages;
const resultSchema = z.object({ ok: z.boolean(), error: errorCodeSchema.optional() });
// Unknown input deliberately avoids schema errors serializing secret-bearing values.
export const storePassword = defineRpc({ name: "credential.store", input: z.unknown(), output: resultSchema });
export const deletePassword = defineRpc({ name: "credential.delete", input: z.object({}), output: resultSchema });
export const credentialStatus = defineRpc({ name: "credential.status", input: z.object({}), output: z.object({ stored: z.boolean() }) });
export const testConnection = defineRpc({
  name: "connection.test",
  input: z.object({ route: z.enum(["automatic", "fallback"]) }),
  output: resultSchema.extend({ serverId: z.string().optional(), route: z.enum(["automatic", "fallback"]).optional() }),
});
