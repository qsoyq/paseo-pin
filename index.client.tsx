import type { PluginClientContext } from "@getpaseo/plugin/client";
import SettingsScreen from "./client/settings.tsx";
export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({ id: "connection", title: "paseo-pin", icon: "Pin", Component: SettingsScreen });
}
