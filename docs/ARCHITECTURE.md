# 架构与关键设计

状态：P01 桌面与构建版本见 [ADR-001](decisions/ADR-001.md)；传输/渲染/IPC/SDK 仍须经过 P02–P06 试验。不要把候选库写成已验证实现。

P02 渲染/增量解码与候选屏幕范围见 [ADR-005](decisions/ADR-005.md)：合成样本通过，vt100 resize/reflow 差异仍开放，服务 screen 不宣称与 UI 完全一致。

P03 SSH2 候选见 [ADR-002](decisions/ADR-002.md)（PROPOSED）：russh 回环协议已验证，真实端点、完整认证/算法矩阵及服务整合尚未完成。

P04 SSH1 见 [ADR-003](decisions/ADR-003.md)（PROPOSED）：Plink 0.85 仅通过启动/banner/无自动切换探针；Windows 原版缺少 resize 路径，独立 helper 和真实握手仍待完成。

P05 串口候选见 [ADR-006](decisions/ADR-006.md)（PROPOSED）：原生枚举与字节逻辑通过，未打开设备，驱动收发与控制线行为未验收。

P06 mock SDK/stdio 见 [ADR-004](decisions/ADR-004.md)：rmcp 3.8.0 与实际 Codex CLI 客户端互通通过；Named Pipe、配对、统一服务和真实会话仍未实现。

P07.1 已建立协议中立领域/内存配对身份与 [IPC v1](../contracts/ipc/README.md)，P07.2 已验证原生 ACL/独立服务与跨进程共享状态，P07.3 已验证桌面持有服务、页面暂停/重载及正常/异常退出，见 [ADR-007](decisions/ADR-007.md)。真实传输仍未接入服务。

P08 已建立 SQLite 配置/迁移、Windows DPAPI/AES-GCM 凭据、Desktop 专用配置线程及编辑器、主机信任存储/管理和事务恢复。见 [P08 汇总](records/P08.md)、[恢复决定](decisions/ADR-012.md)、[凭据整理边界](decisions/ADR-013.md)。保存配置不连接设备；真实握手仍待 P09/P13。
## 分层

```text
Tauri 桌面 / React + xterm.js       Codex
             │                      │ MCP stdio
             │                  terminal-mcp.exe（规划）
             └─────────┬────────────┘
                当前用户 Named Pipe IPC
                       │
       Rust session-service（独立普通用户进程）
       授权 / 生命周期 / 输入队列 / 输出缓冲 / 审计
               │            │             │
           SSH2 adapter  SSH1 adapter  SERIAL adapter
               │            │             │
            服务器        旧设备         COM 设备
```

SQLite 保存结构化配置；Windows Credential Manager/DPAPI 保存秘密；滚动日志单独存储。前端不能持有私钥明文或绕过服务直接操作连接。

P08.3 后端阶段已将配置模型提取至 config-model，由服务专用 OS 线程独占 SQLite/DPAPI，16 条有界队列；active Desktop 专用配置 IPC 不返回已保存秘密。当前仅显式 --data-dir 启用，桌面编辑器/主机密钥/备份恢复仍在实施，见 [ADR-010](decisions/ADR-010.md)。前端新输入的凭据仅提交到服务，不提供读取已保存秘密接口。

## 规划目录（P01 以后创建）

```text
apps/desktop/             React UI 与 Tauri 外壳
crates/session-core/      状态机、权限、调度、缓冲
crates/session-protocol/  版本化 IPC 类型、schema 与有界帧
crates/session-service/   Named Pipe 服务及进程生命周期
crates/transport-ssh2/    SSH2 适配
crates/transport-ssh1/    SSH1 隔离适配
crates/transport-serial/  串口适配
crates/mcp-bridge/        Rust MCP stdio 桥接（SDK 在 P06 决定）
contracts/               IPC/MCP schema 和兼容性样本
tests/fixtures/          合成输出、脱敏兼容样本
scripts/                 构建与验证命令
docs/                    方案、证据、决策与变更
```

## 关键边界

### 协议与终端

- xterm.js 只负责终端显示/输入，不是 SSH/SERIAL 实现。
- SSH2 优先验证 libssh 或合适 Rust 库；认证、主机密钥、PTY、exec、算法兼容、部署与许可共同决定选型。
- SSH1 优先验证 PuTTY/Plink 独立子进程适配；需要验证双向交互、终端尺寸、认证与错误码，不能假定管道就有完整 PTY 能力。不加载或分发 Xshell 私有 DLL。
- 串口原始字节先进入有界缓冲/日志，再增量解码。编码跨块状态不可丢失；HEX 路径不做字符转换。
- 连接状态：DISCONNECTED → CONNECTING → AUTHENTICATING（串口可跳过）→ CONNECTED → CLOSING → DISCONNECTED；任意阶段可进入 FAILED。重试创建新的连接代次。

### 输出与流控

每个输出事件包含 connection_id、generation、seq、timestamp、原始数据/解码信息。read 返回 next_cursor、available_from、truncated 与断连状态。旧代次游标不能静默用于新连接。

原始流、屏幕快照、审计记录分开管理。屏幕快照需要服务端终端状态模型，不能依赖 GUI 一直打开；P02 验证解析器与 xterm.js 的一致性，截图不作为首版机器接口。

慢 UI/慢 Codex 消费者不能阻塞串口读取。队列有界，溢出显式报告；日志落盘失败须显示状态，不可悄悄称日志完整。

### 输入与任务

每连接一个串行写队列；来源为 user/agent/broadcast/trigger。Agent 写入租约绑定连接代次与授权范围；用户接管撤销租约，清理尚未发送的 Agent 输入。

每次写入分配 request_id。重试同一 request_id 返回已有结果，不重复发命令。断连时“已发送但响应未知”报告 UNKNOWN，不自动重试。多目标广播是逐目标结果，不提供跨服务器事务或回滚承诺。

触发器匹配跨数据块的有界文本窗口，包含冷却、次数上限、来源标记；禁止回显触发无限发送；正则引擎避免灾难性回溯。

### 本地 IPC 与授权

Named Pipe ACL 限定当前用户，拒绝远程客户端；通过启动/配对票据将 MCP 客户端绑定到显式授权，权限不能由调用者自填字段决定。ACL 不提供抵御同账户恶意进程的绝对隔离，应记录这一威胁边界。

首次主机密钥/变更、凭据输入在桌面处理；Codex 得到 AUTH_REQUIRED 等结构化结果。授权分 read、write、exec、connect、serial_control、broadcast；支持仅观察、单次确认、限时任务授权。授权过期、断连重建和用户撤销需重新校验。

外部终端内容视作数据，不可改变工具权限；认证信息不返回 MCP。只允许读取获授权连接，输出限额与脱敏应在服务端实施，不能仅靠提示词。

### 持久化与维护

表建议：profiles、folders、workspaces、quick_commands、triggers、settings、schema_migrations。凭据仅 credential_ref；活动连接和授权租约默认不跨进程重启恢复。

迁移前备份，事务更新，错误时恢复；旧版本面对较新 schema 应拒绝写入。导出默认排除秘密；导入路径、重复 ID、未知字段需校验并提供报告。

服务不以管理员或系统服务运行。UI 关闭可选择断连退出或保持后台；服务崩溃明确提示全部连接丢失。更新时先处理活跃连接，不能强制中断正在工作的会话。

## 决策与风险

| 风险 | 验证/处理 | 对应步骤 |
|---|---|---|
| SSH1 后端不能满足终端交互 | 独立试验，必要时替换后端并写 ADR；不隐瞒需求缺口 | P04、P13 |
| WebView 高频输出卡顿 | 批量渲染、背压、上限、真实速率测试 | P02、P22 |
| 旧编码/终端差异 | 合成字节边界样本与真实程序验证 | P11、P23 |
| 串口 DTR/RTS 意外复位 | 打开前明确参数、记录驱动行为、用测试设备验证 | P05、P10 |
| Codex 受策略禁用 MCP | 记录具体版本/策略；不绕过组织配置 | P06、P16 |
| Xshell 私有格式/加密 | 仅映射可读取字段，未支持字段出报告 | P21 |
| 依赖许可或打包不适用 | P01 建清单，P25 复核 NOTICE/SBOM | P01、P25 |

## 资料（2026-11-03 核对/选型入口）

- [Codex MCP 官方文档](https://developers.openai.com/codex/mcp)：本次已读取，支持本地 stdio 配置。
- [Tauri 权限](https://tauri.app/security/capabilities/) 与 [xterm.js 安全](https://xtermjs.org/docs/guides/security/)：前序方案已核对，实施时重新核对所锁版本。
- [libssh](https://www.libssh.org/) 与 [PuTTY FAQ](https://www.puttyssh.org/0.83/htmldoc/AppendixA.html)：SSH2 与 SSH1 候选能力依据，非适配器已验收证明。
- [Xshell 7 标签组](https://netsarang.atlassian.net/wiki/spaces/EN7/pages/419956992/Tab%2BGroup)：交互参考。
