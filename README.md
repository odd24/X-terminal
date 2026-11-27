# Windows 终端模拟器

共享终端是用于 SSH 服务器工作、串口/UART 调试与日志采集的 Windows 桌面应用，支持通过 MCP 与 Codex 共享已批准的会话。

**本机已安装 Windows x64 0.1.40。** 从开始菜单打开「共享终端」，「共享终端 0.1.39」为回退入口。直接使用便携包时，保留三个相邻 EXE，启动 `shared-terminal-desktop.exe`。需要 Microsoft Edge WebView2。[便携版使用说明](docs/WINDOWS_PORTABLE.md) · [部署验证](docs/records/P26.109.md)

## 日常使用

- **连接。** 从连接库打开已有 SSH2 或串口条目，也可用「更多工具」打开连接表单。SSH 按正常流程验证主机和身份。串口可用于交互或只接收。标签支持拖动排序、分屏和独立窗口，本地标签也可拖动。复制手势及适用会话见[桌面交互基线](docs/UI_GUIDELINES.md#现行桌面交互基线)。
- **录制。** 用 SSH2 或串口标签上的录制按钮开始和停止。在「更多工具 → 软件设置 → 日志」设置可读日志目录。默认写入当前数据根的 `logs`，目录修改从下一次录制生效。工具栏文件夹打开当前目录，停录通知可打开该次原文件。[日志使用说明](docs/WINDOWS_PORTABLE.md) · [文件身份与测试](docs/records/P26.23.md)
- **数据。** 默认数据根是 `%LOCALAPPDATA%\local.shared-terminal.desktop`。可用 `--data-dir` 指定独立绝对路径。同一数据根由一个运行中的服务持有，配置占用解除后可使用「重新检查配置目录」。[启动与排查](docs/WINDOWS_PORTABLE.md)
- **Codex。** 在 Desktop 的「更多工具 → Agent 授权 → MCP 初版连接」核对当次桥进程及批准范围。0.1.40 便携包的 MCP v14 支持 `version: "v3"` 和独立描述授权，0.1.37 配套 v13 桥继续以 `version: "v2"` 管理四类配置。[Codex 接入](docs/CODEX_INTEGRATION.md#v14-右栏快捷指令)

## 执行入口

贡献者先查[仓库执行规则](AGENTS.md)、[需求](docs/REQUIREMENTS.md)及[执行路线](docs/EXECUTION_PLAN.md)。界面改动按[维护手册](docs/UI_GUIDELINES.md)复用控件并选择定向验证。查[执行台账](docs/EXECUTION_LOG.md)、[测试计划](docs/TEST_PLAN.md)、[变更管理](docs/CHANGE_CONTROL.md)和[变更日志](CHANGELOG.md)了解步骤及证据。

## 本地开发

使用 Node 24.14.0、npm 11.9.0、`rust-toolchain.toml` 固定的 Rust 1.99.1、MSVC、Windows SDK 和 WebView2。Windows 桌面构建用 PowerShell 7 和 Visual Studio Build Tools 的 MSBuild Roslyn 编译仓库锁定的 PSReadLine 2.0 兼容模块。工具链脚本在仓库已有本地工具时切换环境，也可使用准备好的系统工具链。[环境清单](docs/evidence/P01-environment.md)

```powershell
. ./scripts/Enter-Toolchain.ps1
npm ci --ignore-scripts
npm run desktop
```

`npm run desktop` 启动 Tauri 开发窗口。独立调试产物用 `npm run desktop:build` 生成。常规默认目标为 `target/debug`，可用其中的 Desktop EXE 和 `--data-dir` 开独立测试实例。构建后可运行 `npm run preview:local`，复制三个相邻二进制并在隔离根做启动和退出检查。[开发预览与阶段资料](docs/LOCAL_PREVIEW.md)

| 改动 | 检查入口 |
|---|---|
| Markdown | `pwsh -NoProfile -File scripts/Validate-Docs.ps1`，再检查相关锚点和 `git diff --check` |
| 桌面前端 | `npm run lint`、`npm test`，前端打包用 `npm run build` |
| 终端解析和历史 | 按影响运行 `npm run test:screen`、`npm run test:history` |
| Rust | `cargo fmt --all -- --check`，对受影响的 crate 执行 `cargo test -p <crate> --locked` 和 `cargo clippy -p <crate> --all-targets --locked -- -D warnings` |
| 原生行为与端到端 | `npm run desktop:build` 后按[维护手册定向用例](docs/UI_GUIDELINES.md#可用性与执行证据)运行专项。已有组合入口为 `npm run test:desktop`，后续发布专项另见打包脚本 |

<a id="开发预览与阶段资料"></a>
<a id="显示偏好与复制粘贴p12开发预览"></a>

按[执行台账](docs/EXECUTION_LOG.md)查历史开发记录。旧版显示、复制和粘贴的阶段证据见 [P12](docs/records/P12.md)，现行行为见[维护手册](docs/UI_GUIDELINES.md#现行桌面交互基线)。

<a id="已确认与暂定"></a>

## 架构

- [桌面前端](apps/desktop/src)使用 React、xterm.js 和共享样式。 [Tauri 原生层](apps/desktop/src-tauri/src)对接窗口、系统选择器、受控文件操作和本机会话服务。
- [会话服务](crates/session-service)通过 [会话核心](crates/session-core)和[协议](crates/session-protocol)管理连接代次、输入调度、录制及授权。传输层包括 [SSH2](crates/transport-ssh2)、[串口](crates/transport-serial)与显式开启的 [SSH1 兼容路径](crates/transport-ssh1)。
- [配置库](crates/config-store)、[凭据保护](crates/credential-vault)、[终端日志](crates/terminal-log)和 [MCP stdio 桥](crates/mcp-bridge)各有独立边界。[架构方案](docs/ARCHITECTURE.md)

## 构建 Windows x64 便携目录

从仓库根、已准备依赖的 PowerShell 中构建目标版本。

```powershell
. ./scripts/Enter-Toolchain.ps1
New-Item -ItemType Directory -Path artifacts -Force | Out-Null
cargo build -p session-service --example gui_ssh_fixture --locked --target-dir target
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target/windows-x64-portable'
cargo build -p session-service -p mcp-bridge --locked --release --target x86_64-pc-windows-msvc
npm run tauri --workspace apps/desktop -- build --target x86_64-pc-windows-msvc --no-bundle --config src-tauri/tauri.release.conf.json
pwsh -NoProfile -File scripts/Prepare-Windows-Portable.ps1
```

[打包脚本](scripts/Prepare-Windows-Portable.ps1)生成便携目录、清单、ZIP 与 SHA-256 校验文件，并在 ZIP 解压副本上运行发布专项。打包以当前 Git 提交为源码基准，并在交付路径已存在时停止。只需要目录时可传入 `-DirectoryOnly`。当前用户安装和 MCP 注册有单独的部署记录。MSI、Authenticode 签名及干净系统验收的状态见 [P25/T21](docs/records/P25.md#正式-t21-前置)。[0.1.41 发行记录](docs/records/P26.116.md)
