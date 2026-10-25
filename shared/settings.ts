import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  fallbackEnabled: z.boolean().default(false),
  endpoint: z.string().max(2048).default(""),
  credentialSource: z.enum(["literal", "environment", "file"]).default("environment"),
  environmentName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default("PASEO_AUTO_PIN_PASSWORD"),
  filePath: z.string().max(4096).default(""),
  fileKind: z.enum(["password", "localCredential"]).default("password"),
});
export const connectionSettings = defineSettings({
  id: "connection", scope: "host", version: 1, schema: settingsSchema,
});
export type ConnectionSettings = z.output<typeof settingsSchema>;
