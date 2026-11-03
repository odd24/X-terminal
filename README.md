# Windows 终端模拟器

面向 SSH/串口调试、延续 Xshell 使用习惯、支持 Codex 通过 MCP 协作的 Windows 桌面终端。

当前状态：**P02 合成终端渲染原型**。原生桌面已构建启动，支持合成回放和本地键盘验证；尚无 SSH、串口和 Codex 会话功能。验证与完成状态见执行台账。

## 执行入口

1. 阅读 [AGENTS.md](AGENTS.md)：协作约束与每步 Git 提交规则。
2. 阅读 [需求基线](docs/REQUIREMENTS.md) 和 [架构方案](docs/ARCHITECTURE.md)。
3. 按 [执行计划](docs/EXECUTION_PLAN.md) 的依赖和阶段门推进。
4. 在 [执行台账](docs/EXECUTION_LOG.md) 更新状态并创建步骤记录。
5. 需求/架构发生变化时按 [变更管理](docs/CHANGE_CONTROL.md) 操作。

配套文档：[Codex 接入](docs/CODEX_INTEGRATION.md) · [验收计划](docs/TEST_PLAN.md) · [变更日志](CHANGELOG.md)。

## 已确认与暂定

- 已确认：Windows、SSH1/SSH2、SERIAL、会话管理、标签组、同步输入、快速命令、撰写窗格、触发器、首版外部 Agent 为 Codex。
- 暂定：Windows 10/11 x64；Tauri 2、React、xterm.js、Rust、SQLite；本地 stdio MCP 桥接。
- 未确认：实际 SSH1 设备、串口参数、旧 UNIX 版本、认证环境、最低系统版本、正式产品名。
- v1.0 必须包含用户提出的功能；内置 AI 聊天、SFTP、X11、云同步为后续候选，不代替首版 Codex 接入。

所有执行步骤均需本地 Git 提交；不自动推送、发布或修改用户全局 Codex 配置。

## 本地开发

Node 24.14.0 / npm 11.9.0；Rust 1.99.1 MSVC（rust-toolchain.toml）；MSVC 与 Windows SDK、WebView2 是系统前置条件。版本和本机调查见 [ADR-001](docs/decisions/ADR-001.md) 与 [环境清单](docs/evidence/P01-environment.md)。

```powershell
. ./scripts/Enter-Toolchain.ps1
npm ci --ignore-scripts
npm run lint
npm run build
npm test
npm run test:screen
cargo test -p transport-ssh2 --locked
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run desktop
# 生成本地调试版桌面可执行文件，不打安装包
npm run desktop:build
npm run test:desktop
```

仓库本地 Rust 存放在被忽略的 .tools 目录，其他开发机可以使用已安装的 rustup；Enter-Toolchain 仅在本地工具存在时切换。安装依赖后可用 `node scripts/Dependency-Licenses.mjs --cargo` 更新依赖许可元数据。产品代码许可尚未确定，当前 workspace 标为 LicenseRef-Proprietary；不暗示获得第三方分发权。安装发布留待 P25。

P03 的 SSH2 测试服务器只在回环地址启动，key/测试口令在内存生成；这证明协议子项，不代表 Linux/UNIX/真实设备验收。具体缺口见 [P03 矩阵](docs/evidence/P03-ssh2-matrix.md)。
