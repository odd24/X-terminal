# 方案执行计划

版本 0.1；基线日期 2026-11-03；首版外部 Agent：**Codex**。

## 执行单位与完成定义

每个 Pxx 是一个可验收工作包，至少对应一个本地 Git 提交。包内可拆 Pxx.1、Pxx.2，每个实际执行的子步骤也必须提交；拆分前更新本计划和台账。命令、读文件等过程动作不要求逐命令提交；有独立产物/结论的执行步骤必须提交，不能等阶段结束才一次提交全部工作。

每步必须具备：前置依赖 → 实现/试验 → 验证证据 → 更新 docs/records/Pxx.md 和台账 → 检查暂存内容 → 本地提交 → 核对历史与工作区。失败/阻塞也记录证据并提交可保留的成果，不伪造完成状态。

状态及提交关联规则见 [变更管理](CHANGE_CONTROL.md)。完整版本所有 R01–R14 通过才可交付；阶段原型不替代完整需求。

## 阶段与投入估算

| 阶段 | 步骤 | 退出条件 | 估算投入 |
|---|---|---|---|
| G0 技术可行性 | P01–P06 | SSH1/SSH2/串口/渲染/Codex 的风险结论与后端选型 | 8–12 人日 |
| G1 基础终端 | P07–P12 | SSH2、串口、多标签、配置、日志真实可用 | 15–20 人日 |
| G2 Codex Preview | P13–P16 | SSH1 完整路径与 Codex 同会话读写闭环 | 10–15 人日 |
| G3 Beta | P17–P21 | 用户所需效率功能、迁移、工作区齐备 | 12–18 人日 |
| G4 v1.0 | P22–P25 | 性能、兼容、恢复、安装与最终验收 | 15–25 人日 |

共约 60–90 人日（单人全职 12–18 周），非固定交付日期；真实设备等待不计开发工时。P06/P16 若遇受管 Codex 策略，不能通过更改组织策略绕开。不得因时间预算删除 SSH1 或串口能力。

2026-11-03 排期调整：[CR-001](changes/CR-001.md) / D03 根据用户“后续验收”，允许不依赖真实设备结果的软件工作先行。P03–P05 保留未完成验收状态；G0 完整验收不自动通过。后续依赖可使用已完成的软件/候选结论子项作为开发输入，仍逐项登记未完成内容；阶段/发布验收必须补齐原有证据。SSH1 resize/凭据桥的软件缺口不豁免。

## 逐步工作包

### P01 环境与仓库骨架

- 依赖：D02 文档治理完成。
- 动作：记录 Windows 构建号、CPU/RAM、Codex 版本、Rust/Node/包管理器/MSVC/WebView2 可用性；选定并固定版本；创建最小 Tauri/React/Rust workspace；加入锁文件与依赖许可清单。
- 产物：可启动空窗口、环境清单、实际 build/lint/test 命令、ADR-001 技术基线；更新 AGENTS.md 中尚不存在的命令。
- 验收：干净依赖安装后构建启动；中文工作目录可用；不得把未安装工具写成已可用。
- 提交：`chore(P01): initialize desktop and toolchain baseline`。

### P02 终端渲染与输出原型

- 依赖：P01。
- 动作：xterm.js 接入合成 ANSI/UTF-8 字节流；验证键盘、缩放、替代屏幕和增量输出；评估服务端屏幕解析器与编码转换路径。
- 产物：原型、可重放样本、UI/服务端屏幕一致性报告、缓冲策略结论。
- 验收：跨块多字节/控制序列不损坏；高输出时可输入；服务端快照与 UI 内容一致的范围明确。
- 提交：`feat(P02): validate terminal rendering pipeline`。

### P03 SSH2 后端试验

- 依赖：P01、P02。
- 动作：候选库比较；连隔离测试服务器；验证密码/密钥/交互认证、host key、PTY resize、exec、保活和断线。
- 产物：SSH2 原型、算法/认证支持表、ADR-002 后端决策。
- 验收：真实交互程序可用，主机密钥变化阻断；exec 与 shell 状态差异记录。
- 提交：`feat(P03): validate ssh2 backend`。

### P04 SSH1 兼容试验

- 依赖：P01、P02。
- 动作：验证独立 SSH1 后端的启动、双向 I/O、PTY/尺寸、凭据提示、退出、打包许可；隔离测试端点禁止公开暴露。
- 产物：原型、兼容矩阵、ADR-003；不可行时列替代方案和阻塞证据。
- 验收：证明实际使用 SSH1 完成交互；SSH2 失败不自动降级；真实用户设备未测时单列待验收。
- 提交：`feat(P04): evaluate legacy ssh1 adapter`（仅报告时使用 docs 类型）。

### P05 串口底层试验

- 依赖：P01。
- 动作：COM 枚举、打开/关闭、参数与控制信号；虚拟串口环回后测试实际设备；观察拔插和占用。
- 产物：原型、设备/驱动矩阵、字节收发证据。
- 验收：数据校验一致；CR/LF 不误改；记录打开时 RTS/DTR 行为；无实机则实机项 BLOCKED。
- 提交：`feat(P05): validate serial transport`。

### P06 Codex MCP 最小贯通

- 依赖：P01。
- 动作：选择并锁定 MCP SDK；假连接实现 list/read；验证 stdio 协议、超时、退出、Codex 发现工具与客户端策略。
- 产物：桥接原型、ADR-004 SDK/IPC 决策、脱敏客户端验证记录。
- 验收：真实 Codex 能调用假连接；明确这是 mock，不算真实终端验收。
- 提交：`feat(P06): prove codex mcp integration`。

### P07 会话服务与 IPC

- 依赖：原基线为 P02–P06 结论齐备、G0 通过。按 CR-001，P02/P06 完成、P03–P05 候选结论与缺口登记后，可先实施协议中立的服务/IPC/隔离验证；这不表示 G0 完整验收通过，也不解锁未实现的传输能力。
- 动作：实现连接状态机、generation、Named Pipe ACL、版本握手、配对身份、事件队列、单实例和生命周期。
- 产物：session-core/service、IPC schema、状态机测试、故障诊断。
- 验收：无权客户端被拒、旧代次失败、重复启动处理正确；UI 重载不丢服务连接。
- 提交：`feat(P07): implement session service and ipc`。

### P07.1 会话领域与版本化 IPC 契约

- 依赖：P02/P06、CR-001；P03–P05 已有候选结论和缺口。
- 动作：实现状态转换、connection_id/generation、有界原始输出游标、最小配对身份与只读票据；定义严格 JSON 帧与 schema。
- 验收：非法转换/旧代次/越权连接拒绝；输出缺口显式；新代次不保留旧输出/授权；参数与帧限额有测试。
- 产物：session-core、session-protocol、schema 和测试，不声明原生 ACL 已通过。
- 提交：`feat(P07.1): define session domain and ipc contract`。

### P07.2 Windows 会话服务与受限 Named Pipe

- 依赖：P07.1。
- 动作：当前用户 SID DACL、远程拒绝、首实例、版本握手、票据身份、连接上限/超时、独立进程及诊断。
- 验收：真实 Windows Pipe 跨进程调用；无票据/错误票据/旧代次拒绝；受限 token 的 OS 访问拒绝；重复实例和服务退出正确。
- 产物：session-service、原生 IPC 客户端、Windows 集成测试；默认不打开实际设备。
- 提交：`feat(P07.2): implement secured windows session service`。

### P07.3 桌面共享服务生命周期

- 依赖：P07.2。
- 动作：Rust 外壳通过私有启动通道启动服务，renderer 仅调用已注册 IPC；重载/多个客户端共享同一服务状态；退出/后台状态明确。
- 验收：实际 WebView 重载保持 connection_id/generation/输出；服务崩溃明确反馈；关闭不重放输入；P07 父步骤范围完成后再标 DONE。
- 产物：桌面整合、脱敏集成证据、使用/故障说明。
- 提交：`feat(P07.3): integrate desktop session service lifecycle`。

### P08 配置与凭据

- 依赖：P07。
- 动作：SQLite schema/迁移、Profile CRUD、目录树、凭据引用、主机密钥库、备份恢复。
- 产物：配置服务和会话编辑器、脱敏样本、迁移/恢复用例。
- 验收：重启数据保留，导出无秘密，损坏数据库可诊断；未知 schema 不覆盖。
- 提交：`feat(P08): persist profiles and protected credentials`。

### P08.1 配置模型与 SQLite 迁移

- 依赖：P07。
- 动作：带类型的 SSH1/SSH2/SERIAL Profile、目录约束、SQLite 版本/迁移/事务、凭据引用、配置快照导出和备份恢复基础。
- 验收：重启保留、拒绝循环目录/非法配置、迁移失败回滚且有迁移前备份、未知版本和损坏数据不覆盖；配置导出不含凭据引用/秘密。
- 产物：独立 config-store 与真实临时数据库测试、ADR。
- 提交：`feat(P08.1): persist typed profiles with transactional migrations`。

### P08.2 Windows 保护凭据

- 依赖：P08.1。
- 动作：当前用户 Windows 保护存储、凭据引用、写入/读取/删除与错误处理，秘密不经配置导出。
- 验收：真实 Windows 合成秘密往返与错误/损坏拒绝、无明文落盘，未知引用不返回假值。
- 产物：凭据存储实现/原生测试，不使用真实设备秘密。
- 提交：`feat(P08.2): protect credential storage on windows`。

### P08.3 配置服务与会话编辑器

- 依赖：P08.1/P08.2。
- 动作：服务独占配置入口、受限 IPC、桌面目录/Profile CRUD/凭据编辑/主机密钥/备份恢复。
- 验收：实际桌面重启保留、导出无秘密、未知 schema/损坏故障明确；所有路径通过统一服务。
- 产物：桌面操作与跨进程/原生 WebView 验证，完成后汇总 P08。
- 提交：`feat(P08.3): expose configuration service and profile editor`。

### P09 SSH2 正式接入

- 依赖：P03、P07、P08。
- 动作：原型整合为 transport；认证 UI、主机指纹、保活、窗口尺寸、exec 任务和断线反馈。
- 产物：可在 GUI 操作的 SSH2 会话与集成测试。
- 故障补证：重协商期间沿用当前服务信任策略，并发 shell/resize/exec 不串流；锁定库缺口及本地补丁见 ADR-019。长期容量见下列窗口决定；真实端点验收独立保留。
- 长期容量：按 ADR-020 实施输入回执退休水位与 UUIDv7 桌面输入；不能回收活跃记录或让旧 ID 换动作重发。任务/连接历史见 ADR-021/022，长稳实测留 P22。
- 任务容量：按 ADR-021 回收已结束且已出队的有序任务，局部/全局限额不变；过期 ID 查询或换动作均不可重跑。连接历史见 ADR-022，长稳实测不豁免。
- 连接容量：按 ADR-022 显式移除已结束连接，Start/Reconnect 回执采用独立退休窗口；64/1024 上限不扩大，清理不会重放旧建连请求。实机/长稳保持开放。
- 验收：R01；错误认证、未知/变更主机密钥、exec 非零退出码、网络中断均有准确状态。
- 提交：`feat(P09): integrate ssh2 sessions`。

### P10 串口正式接入

- 依赖：P05、P07、P08。
- 动作：参数编辑、文本/HEX、RTS/DTR/Break、换行/节奏、设备身份与占用/拔插处理。
- 产物：GUI 串口会话、原始字节日志入口、实机记录。
- 验收：R03；COM 号变化不误连其他设备；不同波特率和流控按设备能力测试。
- 提交：`feat(P10): integrate serial debugging sessions`。

### P11 编码、日志与终端行为

- 依赖：P02、P09、P10。
- 动作：增量解码、滚屏/搜索、复制粘贴、原始/文本日志、轮转、磁盘不足反馈、服务端 screen。
- 产物：日志和终端公共组件、跨块编码/程序兼容用例。
- 验收：R04/R12；vim/top/less/tmux、中文、Ctrl+C、粘贴模式可用；日志截断有证据。
- 提交：`feat(P11): add terminal fidelity and bounded logging`。

### P12 基础桌面体验

- 依赖：P08–P11。
- 动作：会话树搜索、标签开关/排序/状态、基础撰写窗格、复制/粘贴习惯选项、主题字体。
- 产物：Alpha 构建和基础用户说明。
- 验收：并行 SSH+串口，关闭确认/后台策略一致；撰写不会发送到错误标签；G1 通过。
- 提交：`feat(P12): deliver daily terminal alpha`。

### P13 SSH1 正式兼容

- 依赖：P04、P07、P08、P11。
- 动作：接入生产适配器、参数/认证 UI、错误映射、进程清理和算法标识。
- 产物：SSH1 会话与真实端点验证报告。
- 验收：R02；旧端点交互、重连、resize；兼容缺口保持开放，不能伪造全支持。
- 提交：`feat(P13): integrate explicit ssh1 compatibility`。

### P14 Agent 授权与输入调度

- 依赖：P07、P09–P11。
- 动作：read/write/exec/connect/control 范围；配对、限时授权、撤销、输入租约、用户接管、request_id 去重、审计。
- 产物：策略引擎、授权/接管 UI、负向测试。
- 验收：越权被拒、重连不继承租约、重试不重复发送；人工接管取消排队写入。
- 提交：`feat(P14): enforce agent access and input ownership`。

### P15 MCP 工具实现

- 依赖：P06、P11、P14。
- 动作：按 CODEX_INTEGRATION.md 实现 schema、read/screen/send/wait/exec/serial/tasks/export；cursor 缺口、超时、长任务和错误语义。
- 产物：真实 MCP 桥接、契约样本、安装路径发现设计。
- 验收：协议测试、权限测试、工具边界和资源清理；stdout 无诊断污染。
- 提交：`feat(P15): expose terminal tools over mcp`。

### P16 Codex 真机闭环

- 依赖：P12–P15。
- 动作：实际版本配置备份/合并；Codex 读取 SSH/串口、诊断、授权发送、接管、中止、导出记录。
- 产物：Codex 安装说明、端到端证据、Preview 构建。
- 验收：同一 connection_id 在 UI 与 Codex 可见；CLI/桌面分别验证；G2 通过。
- 提交：`test(P16): verify codex shared-session workflow`。

### P17 标签组与工作区

- 依赖：P12。
- 动作：拖动分组、横纵分屏、布局持久化、工作区开关、恢复连接选择。
- 产物：布局组件和工作区说明。
- 验收：R06；恢复不重发命令；多份同 Profile 连接 ID 不混淆。
- 提交：`feat(P17): add tab groups and workspaces`。

### P18 同步输入

- 依赖：P14、P17。
- 动作：目标冻结、显著范围显示、逐目标队列与结果；目标断开/认证中/被 Agent 占用的处理。
- 产物：广播输入与状态反馈。
- 验收：R07；只发送选定目标，部分失败准确显示；切换标签不扩大广播集合。
- 提交：`feat(P18): implement explicit session broadcast`。

### P19 快速命令与完整撰写窗格

- 依赖：P12、P14、P18。
- 动作：命令组、变量替换预览、快捷键、文本编辑/历史、选中发送和节奏控制。
- 产物：快速命令编辑器与撰写组件。
- 验收：R08/R09；特殊字符原样，变量未填不发送；取消后未发片段不再调度。
- 提交：`feat(P19): add quick commands and compose workflows`。

### P20 触发器

- 依赖：P11、P14、P19。
- 动作：跨块字符串/正则、动作、作用域、冷却/限次/禁用、循环防护。
- 产物：规则编辑器、合成回放用例。
- 验收：R10；跨块匹配正确、无灾难回溯、回显不无限触发；发送经过同一调度器。
- 提交：`feat(P20): add bounded terminal triggers`。

### P21 批量管理与迁移

- 依赖：P08、P17、P19、P20。
- 动作：批量编辑预览/取消、导入导出版本、冲突策略；授权 Xshell 样本字段映射、未支持字段报告。
- 产物：导入器、示例与迁移说明，不含真实秘密。
- 验收：R05；导入失败不部分损坏现有配置；密码不尝试解密；G3 通过。
- 提交：`feat(P21): add batch management and profile migration`。

### P22 压力与权限边界加固

- 依赖：P16–P21。
- 动作：按 TEST_PLAN 长稳/性能/丢失检测；权限、路径、终端内容注入、跨连接泄露测试；修正瓶颈。
- 产物：环境化测试报告、性能基线与修复。
- 验收：R12/R13 与非功能阈值；未达标开缺陷，不改数字掩盖失败。
- 提交：`perf(P22): validate bounded throughput and access controls`。

### P23 兼容与真实工作试用

- 依赖：P22。
- 动作：Windows 10/11、真实 Linux/UNIX/SSH1、USB 串口矩阵；模拟日常编译/诊断任务；整理缺陷。
- 产物：版本/设备矩阵、任务结果、限制清单。
- 验收：R01–R11 实机覆盖；无设备的行保持 BLOCKED；未支持环境明确声明。
- 提交：`test(P23): verify target systems and devices`。

### P24 故障恢复与升级

- 依赖：P22、P23。
- 动作：服务/UI 崩溃、USB 拔插、网络丢失、磁盘满、数据库迁移失败、重复启动和活跃连接升级行为。
- 产物：恢复流程、迁移备份/回退脚本和故障报告。
- 验收：不重复执行远程命令、不恢复过期授权；升级失败可回到已验证数据版本。
- 提交：`fix(P24): harden recovery and upgrade behavior`。

### P25 安装与发布验收

- 依赖：P24，所有需求验收无阻塞。
- 动作：Windows 安装/升级/卸载测试、版本号、依赖与许可证清单、用户手册、Codex 接入/移除说明、已知限制、构建校验值；评估签名资源。
- 产物：本地 v1.0 候选安装包、完整验收索引、发布检查表。
- 验收：全新测试系统可安装运行；卸载的数据保留选择明确；构建对应 commit 可追溯；G4 通过。
- 提交：`build(P25): package verified windows release candidate`。只生成本地产物，不自动发布；无签名时如实标注。

## 每步回退与重排

代码通过后续 `git revert` 提交回退，不 reset/改写历史；运行时配置/数据库依据该步骤记录恢复备份。Git 回退不能撤销已发送远程命令。每个步骤记录填写专属回退动作。

如果依赖阻塞，可以选择已满足前置条件的步骤继续；跨阶段门需有 CR 说明影响，不能静默跳过验收。新增修复使用 Pxx.1 等子编号或独立 FIX 编号，并关联原步骤、缺陷、验证和提交。
