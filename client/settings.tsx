import { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { connectionSettings, type ConnectionSettings } from "../shared/settings.ts";
import { credentialStatus, deletePassword, errorMessages, storePassword, testConnection } from "../shared/rpc.ts";

type Ready = Extract<SettingsState<typeof connectionSettings.schema>, { status: "ready" }>;
export default function SettingsScreen(props: PluginSurfaceProps) {
  const settings = useSettings(connectionSettings);
  if (settings.status === "loading") return <Text style={{ color: props.theme.colors.foreground }}>正在读取连接设置…</Text>;
  if (settings.status !== "ready") return <SettingsSection title="配置不可用"><SettingsCard>
    <SettingsAction label="读取配置失败" hint="未改变已保存配置。" actionLabel="重新读取" onPress={() => void settings.reload()} />
    <SettingsAction label="恢复默认" hint="关闭兜底；不会删除单独保存的密码。" actionLabel="恢复默认" onPress={() => void settings.reset()} />
  </SettingsCard></SettingsSection>;
  return <Editor key={props.host.id} {...props} settings={settings} />;
}
function Editor({ theme, settings }: PluginSurfaceProps & { settings: Ready }) {
  const [draft, setDraft] = useState<ConnectionSettings>(settings.values);
  const [revision, setRevision] = useState(settings.revision);
  const [dirty, setDirty] = useState(false);
  const [password, setPassword] = useState("");
  const [stored, setStored] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const readStatus = useRpc(credentialStatus);
  const savePassword = useRpc(storePassword);
  const removePassword = useRpc(deletePassword);
  const test = useRpc(testConnection);
  useEffect(() => {
    let active = true;
    void readStatus({}).then((value) => { if (active) setStored(value.stored); }, () => { if (active) setStored(null); });
    return () => { active = false; };
  }, [readStatus]);
  useEffect(() => {
    if (!dirty) { setDraft(settings.values); setRevision(settings.revision); }
  }, [dirty, settings.values, settings.revision]);
  const update = (value: Partial<ConnectionSettings>) => { setDirty(true); setMessage(""); setDraft((old) => ({ ...old, ...value })); };
  const inputStyle = { color: theme.colors.foreground, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, padding: 10, minWidth: 0 };
  const disabled = busy || settings.saving;
  const action = async (work: () => Promise<void>) => {
    if (disabled) return;
    setBusy(true); setMessage("");
    try { await work(); } catch { setMessage("请求失败，请检查与主机的连接。密码不会显示在错误信息中。"); }
    finally { setBusy(false); }
  };
  const input = (key: "endpoint" | "environmentName" | "filePath", label: string, hint: string) => <SettingsRow label={label} hint={hint}>
    <TextInput accessibilityLabel={label} value={draft[key]} onChangeText={(value) => update({ [key]: value })} editable={!disabled} autoCorrect={false} autoCapitalize="none" style={inputStyle} />
  </SettingsRow>;
  const runTest = (route: "automatic" | "fallback") => void action(async () => {
    const result = await test({ route });
    setMessage(result.ok ? `${route === "automatic" ? "自动" : "兜底"}连接成功 · ${result.serverId}` : errorMessages[result.error ?? "unavailable"]);
  });
  return <>
    <SettingsSection title="自动置顶"><SettingsCard>
      <SettingsRow label="paseo-pin · 0.1.0" hint="只对新创建的 workspace 置顶一次。不会补处理历史 workspace，也不会撤销你的手动取消置顶。" />
      <SettingsRow label="默认连接" hint="优先自动识别所属 daemon，使用本地凭据认证。下列设置仅在自动连接失败时使用。" />
    </SettingsCard></SettingsSection>
    <SettingsSection title="连接兜底"><SettingsCard>
      <SettingsSwitch label="启用兜底" hint="设置按当前主机保存，只能连接同一个 daemon。" value={draft.fallbackEnabled} onValueChange={(fallbackEnabled) => update({ fallbackEnabled })} disabled={disabled} />
      {input("endpoint", "daemon 地址", "留空使用自动识别地址；否则填写 ws://127.0.0.1:6767/ws 或 wss://地址/ws。")}
      <SettingsSelect label="凭据来源" value={draft.credentialSource} options={[{ label: "直接输入密码", value: "literal" }, { label: "环境变量", value: "environment" }, { label: "本机文件", value: "file" }]} onValueChange={(value) => update({ credentialSource: value as ConnectionSettings["credentialSource"] })} disabled={disabled} />
      {draft.credentialSource === "environment" && input("environmentName", "环境变量名", "只读取 daemon 插件进程继承的环境。不要填写 $ 前缀；其他终端 export 不会更新运行中的 daemon。")}
      {draft.credentialSource === "file" && <>
        {input("filePath", "凭据文件路径", "路径属于 daemon 主机，不是手机或浏览器。支持绝对路径和 ~/；只读取，不复制文件。")}
        <SettingsSelect label="文件内容" value={draft.fileKind} options={[{ label: "密码文本", value: "password" }, { label: "Paseo local-credential", value: "localCredential" }]} onValueChange={(value) => update({ fileKind: value as ConnectionSettings["fileKind"] })} disabled={disabled} />
        <SettingsRow label="文件格式" hint="UTF-8 单行文本，可带末尾换行；不支持符号链接。local-credential 只用于回环或 Unix socket。config.json 中的密码哈希不能用于认证。" />
      </>}
    </SettingsCard></SettingsSection>
    <SettingsSection title="独立保存的密码"><SettingsCard>
      <SettingsRow label={stored === null ? "密码状态未知" : stored ? "已保存密码" : "未保存密码"} hint="密码不在普通设置中。macOS/Linux 使用 0600 私有文件保存明文，不是加密保险库；不会回传已保存密码。卸载前可在这里删除。" />
      {draft.credentialSource === "literal" && <>
        <SettingsRow label="新密码" hint="单独保存；空白输入不表示删除。">
          <TextInput accessibilityLabel="新密码" secureTextEntry value={password} onChangeText={setPassword} editable={!disabled} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
        </SettingsRow>
        <SettingsAction label="保存或替换密码" hint="与下方连接设置分别保存。" actionLabel="保存密码" disabled={disabled || !password.length} onPress={() => void action(async () => {
          const result = await savePassword({ password });
          if (result.ok) { setPassword(""); setStored(true); setMessage("密码已保存。"); }
          else setMessage(errorMessages[result.error ?? "unavailable"]);
        })} />
      </>}
      <SettingsAction label="删除已保存密码" hint="仅删除插件私有副本，不修改外部文件或环境变量。" actionLabel="删除密码" disabled={disabled || stored === false} onPress={() => void action(async () => {
        const result = await removePassword({});
        if (result.ok) { setStored(false); setPassword(""); setMessage("已删除插件保存的密码。"); }
        else setMessage(errorMessages[result.error ?? "unavailable"]);
      })} />
    </SettingsCard></SettingsSection>
    <SettingsSection title="保存与验证"><SettingsCard>
      <SettingsAction label="保存连接设置" hint={dirty && revision !== settings.revision ? "其他客户端已更新配置，请读取最新配置后再编辑。" : "保存后对新任务生效；不会补处理之前失败的 workspace。"} actionLabel="保存设置" disabled={disabled || !dirty || !connectionSettings.schema.safeParse(draft).success} onPress={() => void action(async () => {
        if (await settings.save(draft, revision)) { setDirty(false); setMessage("连接设置已保存。"); }
        else setMessage("保存失败或配置冲突，草稿已保留。请读取最新配置后重试。");
      })} />
      <SettingsAction label="放弃连接设置草稿" actionLabel="读取最新" disabled={disabled} onPress={() => { setDirty(false); setPassword(""); void settings.reload(); }} />
      <SettingsAction label="测试自动连接" hint="使用已保存设置；仅认证并核对身份，不修改 workspace。" actionLabel="测试自动" disabled={disabled || dirty} onPress={() => runTest("automatic")} />
      <SettingsAction label="测试兜底连接" hint="直接验证兜底配置，即使自动连接正常也可测试。请先保存设置和密码。" actionLabel="测试兜底" disabled={disabled || dirty || !settings.values.fallbackEnabled || (settings.values.credentialSource === "literal" && password.length > 0)} onPress={() => runTest("fallback")} />
      {message ? <SettingsRow label={message} /> : null}
    </SettingsCard></SettingsSection>
  </>;
}
