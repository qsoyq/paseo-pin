# paseo-pin

新 workspace 创建后自动置顶一次。支持 daemon 密码认证，以及设置页里的三种凭据来源。

## 行为

- 监听 `workspace.created`，异步处理，不等待 Agent 或调用模型。
- 所有项目、普通与公共后台 workspace 都处理，不改变置顶组内排序。
- 不扫描历史 workspace，不补处理停用期间或失败的任务。
- 手动取消置顶后不会强制恢复；重载插件不会重新置顶历史 workspace。
- 创建后的短连接读取最新状态，已置顶、归档或不存在时跳过。
- 连接超时 5 秒，总任务超时 10 秒；没有自动重连。置顶请求结果不明时不重试。
- 监听回调立即返回；归档、停用和卸载取消在途处理。读状态与写入不是事务，紧邻创建的手动操作仍存在并发窗口。

## 要求与安装

测试环境为 macOS。版本要求与 paseo-loom 一致：`>=0.9.1`，不设未经证实的不兼容上限。该要求同时用于 daemon 和客户端，因此允许 0.13.0 正式版。已验证 0.9.1、0.12.0-beta.3、0.12.0、0.13.0-beta.2 和 0.13.0；SDK 依赖仍固定 0.12.0，依赖版本不等于宿主下限。未来版本仍需关注内部客户端接口变化。为兼容 0.9.1 的严格 manifest 校验，不声明可选 name 字段，显示名称使用插件 ID paseo-pin。

插件使用可信、非沙箱代码。先在目标主机 Settings → Plugins 启用插件，再从 GitHub 安装：

```sh
paseo plugin install https://github.com/qsoyq/paseo-pin.git
paseo plugin ls
paseo plugin logs paseo-pin
```

本地开发可在仓库目录运行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin ls
paseo plugin logs paseo-pin
```

公开源码仓库：https://github.com/qsoyq/paseo-pin 。未发布 npm 包。GitHub 安装使用 daemon 管理的独立副本；修改本地开发目录不会改变已安装的 GitHub 版本。

## 设置

入口：Settings → Plugins → paseo-pin → paseo-pin。

默认读取所属 daemon 的 PASEO_HOME、运行时监听地址和 local-credential。发现失败不会盲连默认端口。0.9.1 尚无 local-credential：明确未配置密码时使用本机无认证连接；已设置密码时须启用密码兜底。存在但不可读或无效的凭据不会降级为无认证。后台 workspace 查询按宿主能力启用，旧版不发送不支持的参数。

### 连接兜底

显式开启后，只有自动连接失败且还没发出置顶请求时才尝试一次。地址留空继续使用自动识别结果，否则支持 ws://…/ws 或 wss://…/ws，不支持 URL 内嵌凭据、query token、SSH 或 Relay。非回环地址必须使用经过证书校验的 wss://。

连接后核对 serverId，必须是插件所属 daemon。这个身份检查防止误连，不是额外的密码学身份校验。自动发现的 local-credential 不发送到手动外部地址。用户配置的密码只能发往明确指定的目标。

自动连接额外支持 Unix socket（绝对路径或 unix:///…）。手动 local-credential 只能用于回环地址或自动识别的本机 socket。

### 凭据来源

| 来源 | 设置 | 说明 |
| --- | --- | --- |
| 直接输入 | 单独保存密码 | 不放入普通设置，不回传已有值。空白框不是删除，另有删除按钮。 |
| 环境变量 | 变量名，例如 PASEO_AUTO_PIN_PASSWORD | 只读插件进程继承的环境，不读取 shell 配置，不执行命令。其他终端 export 不会更新运行中的 daemon。 |
| 文件 | daemon 主机的绝对路径或 ~/ | 每次连接重新读取。支持密码文本和 Paseo local-credential，二者认证类型不同。 |

文件必须是 UTF-8 单行文本，可带一个末尾换行，密码空格保留。上限 16 KiB，不接受最终路径是符号链接、目录、FIFO 或设备。config.json 中的 bcrypt 哈希不能作为密码。

普通配置与直接输入的密码分开保存。先保存密码，再保存连接设置；测试按钮使用已保存的配置。多客户端保存使用 revision 检查冲突，测试连接只认证和检查身份，不修改 workspace。

### 密码存储与信任边界

直接输入的密码保存在 daemon 主机：

```text
<PASEO_HOME>/plugin-secrets/paseo-pin/password
```

目录 0700、文件 0600，原子写入。这是受文件权限保护的明文，不是加密保险库。macOS/Linux 支持直接保存，Windows 上拒绝私有文件保存，不能把 POSIX 权限当作 Windows ACL。

普通插件设置不包含密码。RPC 只返回已保存状态；日志只输出固定错误码，不输出底层错误对象或凭据。测试覆盖真实 daemon RPC 的日志泄漏，但无法保护同一 OS 用户、其他可信插件或有 daemon 管理权的恶意客户端。UI 到 daemon 的连接也应使用受信任/加密通道。

私有密码不会随普通设置自动删除；卸载前使用“删除密码”，或停用后手动删除上面的私有文件。环境变量和用户提供的文件从不修改。不要用多个安装 ID 部署这个插件，它们会共享同一个私有密码路径。

## 目录

- `index.server.ts`：生命周期与 RPC。
- `server/daemon.ts`：连接发现、认证与身份验证，底层客户端适配层。
- `server/credentials.ts`：凭据读取与私有密码存储。
- `server/pin.ts`：置顶和异步任务生命周期。
- `shared/`：非敏感设置、RPC 契约和固定错误文案。
- `client/settings.tsx`：Paseo 原生设置组件，兼容窄屏与主题。
- `tests/`：单元/网络故障测试、真实 daemon 集成测试和可选浏览器测试。

## 本地验证

```sh
npm run typecheck
npm test
npm audit --omit=dev
npm pack --dry-run --ignore-scripts
```

集成测试需要独立安装的 CLI，不会修改或重启日常 daemon。测试仅使用随机密码、临时目录、回环端口；不运行 Agent，不访问真实工作区。结束时关闭自己启动的进程并清理测试目录。

```sh
npm install --prefix /tmp/paseo-pin-runtime @getpaseo/cli@0.12.0 --ignore-scripts --no-audit --no-fund
PIN_TEST_CLI=/tmp/paseo-pin-runtime/node_modules/@getpaseo/cli/bin/paseo npm run test:integration
```

可选的真实 Web UI 测试（本机 Chrome）：

```sh
npm install --prefix /tmp/paseo-pin-browser playwright --ignore-scripts
PIN_TEST_BROWSER=1 npm run test:integration
```

其他机器可以用 PIN_PLAYWRIGHT_PACKAGE 指向安装 Playwright 的 package.json，用 PIN_CHROME 指向 Chrome 可执行文件。截图输出 /tmp/paseo-pin-ui/，不包含测试密码；PIN_KEEP_TEST_HOME=1 会保留临时测试目录，其中含随机测试凭据，调试结束应删除。

## 已知限制

- 依赖内部 DaemonClient API，不承诺未来 Paseo 升级兼容。
- 置顶在创建后异步发生，不保证 UI 第一帧已经置顶。部分客户端版本有晚到创建快照覆盖置顶显示的问题（上游 PR #7758），插件不会用持续重试掩盖它。
- 手动地址是同一 daemon 的备用入口，不用于跨 daemon 置顶。只读环境变量与文件均位于 daemon 主机。
- 每个短连接使用独立 client ID，避免并发 workspace 操作互相挤掉连接。进程内保留已处理 ID 用于去重，插件重载后释放。
- 未验证实际 iOS/Android 原生客户端、Windows、生产 WSS 反向代理或真实 Unix socket daemon。
