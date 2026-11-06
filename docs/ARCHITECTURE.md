# 架构与关键设计

P14 SSH Disconnect按[ADR-051](decisions/ADR-051.md)推进独立Disconnect/lease、原认证owner/精确代次的有界回执与只查编号恢复；Requested与Actor及共享传输引用实际回收的TransportEnded分开。旧无编号Close保持Desktop专用；串口Disconnect、GUI和真实桥须独立接入，准确验证见P14。

P14串口Start沿[ADR-050](decisions/ADR-050.md)在原有界回执记录认证来源；Profile Connect经配置await后复核，保持库存/设备/端口匹配，OS worker打开前再复核同许可并检查Close取消。打开后的驱动动作不承诺撤回，不授新连接Read/Write/Control，准确结果见P14。

P14 SSH Start沿[ADR-049](decisions/ADR-049.md)在原有界回执内记录认证来源，Profile Connect独立于新连接全部能力；配置await后及连接future首次poll在Store协调边界重验。主机/认证批准仍Desktop，准确结果见P14，串口Start/Disconnect与真实桥继续。

P14尺寸增量按[ADR-048](decisions/ADR-048.md)：SSH2 Resize需要独立Control/lease并沿原认证输入FIFO/owner回执和派发复核；Desktop自身视口调整不接管。GUI Control按目标协议限定SSH尺寸或串口控制线，不能用于建连/断开/认证/广播。实际证据见P14，真实桥与其他动作继续。

P14授权面板沿ADR-047复用公共Panel/Field/tokens，GrantApproval冻结完整代次/独立范围/期限且一次性消费；只编号恢复，原生保持无token投影，严查原编号/当前有效范围与有界审计gap。面板不代替真实stdio桥交付，也不开放尚未接传输的Connect/Disconnect/SSH Resize/广播；实际验证见P14。

P14按[ADR-047](decisions/ADR-047.md)接Desktop专用agent_management_request白名单，使用原配置Pipe，原生独立回复只返回回执/范围/租约与有界审计，协议token不进入WebView。没有Agent租约写入口/通用RPC；实际GUI与真实stdio桥受控交付分别继续，结果见P14。

P14授权管理按[ADR-046](decisions/ADR-046.md)加入128签发回执及UUIDv7退休；Grant必填request_id，保留重试/状态查询只取原ticket/绝对到期与当前有效范围，不续期/恢复接管能力。Desktop管理清单仅摘要，单项才返回范围和有效token，幂等撤销原编号同步擦除token；内存记录不跨服务重启，实际结果见P14。GUI及其他动作/完整审计仍继续。

P14串口输入/控制增量见[ADR-045](decisions/ADR-045.md)：服务认证Identity及固定许可随Work进入原OS worker，在每次至多1024字节驱动尝试（含短写/Interrupted重试、节奏/接收等待后）前复核；撤权结算该请求的已知前缀并停止尾部，保留同连接供用户继续，不能承诺撤回已决定OS调用。输入owner随原有界回执退休，无新永久表；精确实际验证见[P14](records/P14.md)。建连/断开、签发幂等/管理GUI与完整审计仍继续。

P14按[ADR-044](decisions/ADR-044.md)实施核心策略及Pairing真实Agent身份、独立read范围与管理/租约/审计通道。SSH Write/WriteText及独立Exec已接原共享FIFO、固定内部许可和真实client_id回执/任务归属；用户输入及主动Desktop exec接管，异步任务真正启动前再次与撤销同锁复查。自己的任务结果/取消不推导终端Read；保留Start重试只查原回执，不续租/重派发。真实Windows IPC证据见[P14](records/P14.md)。connect/control/disconnect、串口worker逐片段、授权GUI及完整审计仍继续，不能从SSH路径推断全部Agent能力/MCP已开放。

状态：P01 桌面与构建版本见 [ADR-001](decisions/ADR-001.md)；传输/渲染/IPC/SDK 仍须经过 P02–P06 试验。不要把候选库写成已验证实现。

P02 渲染/增量解码与候选屏幕范围见 [ADR-005](decisions/ADR-005.md)：合成样本通过，vt100原始resize/reflow差异在P11.7补充普通屏有界重排，极限容量往返差异仍开放，服务screen不宣称与UI完全一致。

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

P11.2已将增量派生文本和screen放入统一Sessions输出入口，GUI不在也持续维护；ReadText/Screen沿用只读范围校验。来源游标、独立文本窗口、帧限额、缺口/EOF与vt100替换字补丁见[ADR-028](decisions/ADR-028.md)。保留历史覆盖不等于服务源头丢字节；BUG-001 resize/reflow和持久日志仍开放。

P11.3独立terminal-log引擎采用每日志有界文件线程、原始二进制/文本JSONL成对轮转和同步后不覆盖发布完成标志；Windows目录pin拒绝reparse/改名，失败锁定且不阻塞设备。见[ADR-029](decisions/ADR-029.md)及[格式](../contracts/logging/README.md)。当前尚未挂接Sessions，P11.4继续权限、显式启停和服务/桌面故障提示，默认不记录。

P11.4启停阶段将OutputCapture挂接统一Sessions，真实源事件与派生文本成对入日志队列；Desktop专用日志管理和独立Tauri配置通道避免文件准备阻塞输入。默认不捕获、无历史回填、换代不继承，面板关闭/重载不中断已有用户记录。容量/状态/故障及未完成的历史/导出边界见[ADR-030](decisions/ADR-030.md)，不将启停阶段当作整个P11.4完成。

P11.4文件侧ArchiveReader以完成标志和所有段的Windows只读句柄构成不可变读取范围，按有界页检查跨段序号和完成计数，最终finished前不声称全检通过；较早v1缺少源缺口计数保留未知。源缺口累计溢出明确失败。此阶段未暴露历史IPC或导出入口，文件线程/reader配额和故障恢复继续，见ADR-030。

P11.4历史服务采用独立16队列文件actor、8个只读快照和128回执，最近页幂等、严格ConnectionRef/log_id/read_id及游标，空闲/关闭/损坏释放文件；目录状态不将头部核对冒充全文验证。数据目录授权取决于配置线程所有权，SQLite损坏仍可读既有日志。具体配额/水位/帧与未实现界面边界见ADR-030和IPC说明。

P11.4桌面历史使用32KiB服务页，历史目标独立于活动终端；文本/HEX只读显示且控制字符可见，字面搜索跨TextEvent、缺口断开，完整扫描范围、仅保留100条摘录。最终finished与前缀/取消/错误分别显示，reader关闭/回收沿用ADR-030，不将日志写入终端或整份载入前端。导出及失败前缀恢复继续。

P11.4桌面导出显式调用独立服务任务生成受管理JSONL，浏览器只接收经过固定作用域/安全整数核对的状态和计数，成功时显示可复制的完整文件路径，不加载整份文件。单个sessionStorage槽仅保留ID用于用户主动查询；应答不明不自动重启，已发布结果不被晚到取消撤回。见ADR-030；自选位置/打开目录、容量整理/失败前缀恢复继续，未将本入口当完整P11/G1验收。

P11.4容量整理文件库以Windows DELETE句柄固定UUID目录和有限文件集合，预览取消只释放、确认后按句柄逐项删除；未知内容/占用拒绝，途中失败报告确切已删除前缀而非虚假原子回滚。逻辑字节不当作物理释放空间，内容损坏不妨碍已知名称的显式预览。见[ADR-031](decisions/ADR-031.md)；服务/GUI确认、到期与回执/注册治理见下文，默认不自动整理历史。

P11.4服务整理采用独立8队列actor、4个30秒句柄快照和128回执，确认码绑定原目标，提交/取消/到期及重试语义见ADR-031。预览入队前的保留意图随消息存活，提交后的注册失效由actor执行，调用者取消等待或应答丢失不遗漏状态治理；文件I/O外才短时更新内存/解除精确旧失败sink。受影响产物返回REMOVED，有序退休水位阻止旧Start复活；物理目录配额和opaque固定保留不变。桌面已有独立清理预览/确认/到期和REMOVED显示；capture_list提供本次跨连接/旧代次清单，RELEASED只解除已结束失败关联而不删除文件，文件前缀恢复继续。

自选保存的来源基础见[ADR-032](decisions/ADR-032.md)：生产受管理JSONL时累计SHA-256，完成回执才携带指纹，REMOVED清空；Windows VerifiedExport按固定UUID/文件pin，先完整核对再以64KiB缓冲复制并复核实际字节，取消/写失败不授权发布。原生目标选择、私有暂存同步/发布、覆盖确认与打开目录尚未接入，不能由该库接口或完成路径推断已另存到用户位置。

P11.7按[ADR-038](decisions/ADR-038.md)实现普通屏单元格有界重排，screen正文使用物理视口行；parser=vt100-0.18.1+local.2、resize_reflow=true仅表示普通屏重排能力。活动光标组、替代屏沿用xterm默认语义，满容量极窄/极宽序列仍有精确记录的BUG-001差异；原始/文本流不受布局调整影响。


P12按[ADR-042](decisions/ADR-042.md)/[ADR-043](decisions/ADR-043.md)将有限桌面偏好存于同一数据目录的schema 4 SQLite单例，Desktop专用配置线程/16队列、revision保护和备份摘要/事务恢复共用。schema 2旧备份只读构造默认偏好，schema 3保留原偏好并补跟随应用配色，原文件不改写；升级前唯一备份，失败事务回滚，当前格式/IPC字段严格必填。应用主题与终端配色独立，tokens/terminalAppearance共用；便携Profile交换不带偏好。主窗口已接明确保存/读取及习惯，不能持久化草稿/正文/同意或借全局WebView存储跨目录覆盖。


P12主窗口在service_id就绪后读取本数据目录偏好，明确保存才写入；失败/未知撤销窗口可写revision并只由显式读取核对，不自动重发。GUI备份恢复退休旧偏好应答并应用权威值；快捷键/右键继续原统一剪贴板与输入队列。无终端正文/草稿/同意持久化。
