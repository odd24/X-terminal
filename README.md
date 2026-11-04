# Windows 终端模拟器

面向 SSH/串口调试、延续 Xshell 使用习惯、支持 Codex 通过 MCP 协作的 Windows 桌面终端。

当前状态：**P07 桌面/独立会话服务整合**。原生桌面通过受限 Named Pipe 共享合成会话，重载保留输出，服务故障明确反馈；尚无生产 SSH、串口和 Codex 会话功能。验证与完成状态见执行台账。

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
cargo test -p transport-serial --locked
cargo build -p mcp-bridge --locked
npm run test:mcp
npm run test:codex-mcp
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

P05 可用 `cargo run -p transport-serial --example enumerate` 只读列举端口；不自动打开设备。真实字节收发与控制线行为待指定设备验证，见 [P05](docs/records/P05.md)。

P06 已有只读 mock MCP 原型与真实 Codex CLI app-server 客户端互通测试，使用隔离配置、无模型推理，不修改全局设置。它不访问实际会话，见 [P06](docs/records/P06.md)。

P07 已增加协议中立状态机、有界原始输出、内存只读票据与 [IPC v1](contracts/ipc/README.md)，以及受限 Windows Named Pipe 服务。可运行 `cargo test -p session-core -p session-protocol -p session-service --locked`；桌面启动、原生 ACL/跨进程、页面暂停/重载、退出/崩溃已验证，不代表实际设备会话已接入。

P08.1 已有独立 SQLite 配置存储与真实临时数据库测试：`cargo test -p config-store --locked`。配置迁移/备份/新目标恢复、Profile/目录 CRUD 可在库层使用，配置服务与编辑器仍在后续子步骤，见 [ADR-008](docs/decisions/ADR-008.md)。

P08.2 已有 Windows 用户级 DPAPI/AES-GCM 凭据库：`cargo test -p credential-vault --locked`，只用合成秘密验证真实保护 API、跨进程重开与篡改拒绝。配置服务与桌面凭据流程仍待 P08.3，见 [ADR-009](docs/decisions/ADR-009.md)。

`npm run desktop:build` 同时构建相邻的 session-service.exe。直接运行 `target/debug/shared-terminal-desktop.exe` 默认不启用合成接口；追加 `--test-fixture` 可手动新建合成会话。键盘合成回显和高输出均通过同一服务，页面重载从保留游标重新呈现；输出覆盖会明确报缺口。退出桌面会停止服务，当前没有后台保留选项（P12 后续实现）。服务不可用时不自动重连/重放，退出后重新启动会得到全新服务；不能把重载当作重连。启动失败请检查相邻服务文件与普通用户权限，当前不提供安装包。

P08.3 已有 Desktop 专用配置 IPC 后端、有界工作线程和明确配置故障；当前桌面尚未传入数据目录/提供编辑器。进展与主机密钥/导出/备份恢复等剩余项见 [P08.3](docs/records/P08.3.md)。

P08.3 桌面增量已接入“连接配置”：目录与 SSH2/SSH1/SERIAL Profile 编辑、复制/移动/删除、凭据引用管理，保存不打开设备。默认使用应用本地用户目录，可通过 --data-dir 绝对路径选择其他目录；所有自动化测试使用独立临时目录。私钥表单只输入本地普通文件路径，内容由服务读取并加密，源文件不修改，页面不接收私钥明文。主机密钥/配置导出与备份恢复/凭据整理仍在实施，P08.3 尚未完成。npm run test:desktop 同时运行生命周期和配置编辑器的真实 WebView 测试，也可单跑 npm run test:desktop:config。

P08.3 已有主机密钥信任库与 GUI 管理：显示完整指纹，移除须勾选且与当前记录匹配；变更冲突不会自动删除。存储层只读判定未知/已知/变化，批准要求当前版本，SSH1/SSH2/端口分别隔离。真实首次/变化握手确认由 P09/P13 接入，见 [ADR-011](docs/decisions/ADR-011.md)；备份恢复/凭据整理仍未完成。

P08.3 的恢复存储层已增加一致镜像/预览摘要和事务恢复，安全副本不覆盖原文件，中途 SQL 失败回滚。当前尚未提供服务/桌面导出与恢复入口，详见 [ADR-012](docs/decisions/ADR-012.md)；不能将库测试当作用户恢复流程完成。

P08.3 现有“配置导出与备份恢复”入口：便携 JSON 排除凭据引用/信任记录，配置备份保留引用/信任记录但不含秘密或 vault。预览并勾选后可恢复，替换前保存旧库；坏库可恢复到新目录，再用 --data-dir 指定该目录启动。缺引用会提示重新输入。所有操作通过统一服务，不重连已有会话；凭据整理仍在实施。可单跑 npm run test:desktop:archives，细节见 ADR-012。
