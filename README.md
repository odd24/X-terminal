# Windows 终端模拟器

面向 SSH/串口调试、延续 Xshell 使用习惯、支持 Codex 通过 MCP 协作的 Windows 桌面终端。

当前状态：**方案基线已建立，应用尚未实现**。本仓库不包含可运行程序；文档中的目录、命令和接口若标记为“规划”，不代表已经存在。

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
