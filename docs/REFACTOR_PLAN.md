# 共享终端全仓重构方案

审阅基线为 `codex/execution-plan` 的 `8ad5cc2`（[P26.35](records/P26.35.md)）。方案先经 P26.36 入库，随后获用户明确授权依序实施。执行结果从 [R0 基线记录](records/P26.37.md)开始登记。R0–R9 是本文的工作包号。实施时逐步登记仓库 Step-ID，产品需求仍以[需求基线](REQUIREMENTS.md)及原 R01–R16 为准。方案接续 [P26.33](records/P26.33.md) 已完成的两轮局部重构，并挂在[现行执行路线](EXECUTION_PLAN.md#现行路线cr-006)下。

## 一、结论与审查范围

优先解决三个具体的维护问题：拖放同时改变多个位置的状态，复制会话的生命周期横跨多个异步入口，桌面与 MCP 的外部接口适配和内部行为分派需要同步维护。保留桌面、会话服务、桥和传输驱动的进程及授权边界。性能路线先测量 P26.34 遗留的双窗格回显差异，按定位结果决定是否调整读页或 IPC。

清点范围为 Git 跟踪的 1014 个文件的目录与入口，Rust 工作区 12 个成员，以及前端、契约、测试、脚本、两份本地依赖补丁和工程记录。检查深度为模块清点加重点调用链静态阅读。以下“保留”表示现有证据支持维持职责；没有逐行认证所有实现，也没有运行新基准。[P26.35 的 152 项前端测试和桌面专项](records/P26.35.md#实测与交付)为历史证据。所有后续候选均需自己产生验收证据。

| 范围（路径相对于仓库根） | 当前职责与观察 | 处置 |
|---|---|---|
| apps/desktop/src | main.tsx 同时编排窗格、标签、复制、草稿、焦点及本地终端。pane-layout、workspace-session、session-snapshot、shortcut-execution 已有各自所有权 | R1、R2；复用现有模型 |
| terminal-controller.ts、terminal-writer.ts、output-decoder.ts、input-queue.ts | poll 跨越选择验证、编码读取、解析器重置、游标和绘制；切换后多处主动复核目标 | R3、R8；保留各 await 后检查 |
| apps/desktop/src-tauri | main.rs 包含外部命令和目标匹配；session_windows 管窗口许可，service 管服务生命周期。本地 ConPTY、ADB、导出保存已有专属实现 | R4；本地子进程以专项回归覆盖 |
| session-service | server.rs 同时容纳握手审计、领域分派和运行时装配；ssh.rs 管输入接纳及 Actor，同时已有 start、exec、reconnect 等子模块；serial 有独立 worker 生命周期 | R5、R6，分次实施 |
| session-core、session-protocol | 前者拥有权限、输入、会话、呈现、审计规则，后者拥有线协议；协议类型还服务于 desktop 和 MCP | 保留职责；R4–R7 验证新增分派的穷尽性 |
| mcp-bridge、contracts | live.rs 的 list_tools 与 call_tool 各有工具映射；terminal_wait 独立处理，其余调用先取并发许可；contracts/mcp 留存版本快照 | R7，保留历史版本与等待语义 |
| transport-ssh1、transport-ssh2、transport-serial | 协议差异涉及主机信任、SSH1 显式启用、串口阻塞设备及线程退出；串口 worker 有有界容量及 join 顺序 | 维持三个适配器。仅在同一生命周期缺陷有跨协议证据时再提取共性 |
| terminal-log、服务 logging、原生 export_save | 已有存储、恢复、受管导出 worker 与 Windows 文件选择边界；回执登记相似，但最终文件身份、取消时点及完成语义不同 | 保留文件操作所有者。若多个入口修复相同回执缺陷，先比较 RequestWindow 使用方式再提取纯规则 |
| config-model、config-store、credential-vault | 配置模型、SQLite 打开/迁移/备份、当前用户 DPAPI 已分层。config-store 的已有库升级涉及只读源与独占创建备份 | 保留 schema 与凭据引用；相关包以隔离旧库及锁竞争验收 |
| vendor、构建与发行 | russh、vt100 经工作区补丁接入，各自含 LOCAL_PATCH.md；锁文件及三程序布局影响可重现性 | 维持补丁。上游升级另做依赖决策、协议及终端回放验收 |
| tests、scripts、docs | 已有 DesktopHarness、分域专项及契约快照；SessionCopy 与 PaneGroups 都承载多种测试模式 | R0、R9；复用已存在的验证入口 |

## 二、执行顺序与依赖

建议顺序为 R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8 → R9。R0 建立共同基线，R2 依赖 R1 确定的落位接口，R5–R7 可在 R0 后按优先级调整。R8 依赖 R3 的归因证据。未定位到可重复的耗时阶段时，登记 R8 未启动及其依据，再进入 R9。R9 的收尾核验适用于实际完成的全部包。每次只推进一个可独立验证的步骤。出现目标错配、重复发送、丢失审计或文件身份变化时，先保留证据并修复或回退该步骤，复验通过后再继续。对同时涉及搬移和行为修正的发现，分别登记可复现用例和修复步骤。

### R0　冻结对照环境和契约（先做，低风险）

记录提交、二进制散列、构建特性、数据根、窗口数、协议、输入场景和现有失败。以 P26.35 三程序候选作为功能对照，延迟另保留 P26.34 的基线/候选数据。先运行 lint、前端测试及本轮将改变入口的桌面专项；冻结现有命令名、JSON、错误码、MCP 清单与相关 UI 操作轨迹。记录现存失败和重跑结果。交付是可复跑的对照表，区分既有失败与新增失败。证据只含合成数据。准备用于对照的三程序和夹具时，按 [Windows x64 便携目录构建](../README.md#构建-windows-x64-便携目录)执行。优先使用留存候选并核对散列，缺少对应候选时以对应提交和相同构建参数重建，报告注明来源。首次开工覆盖 R1、R2 入口。跨到 R4–R7 前，再按本包范围冻结相关契约和拒绝用例，并留存采集命令与样本版本。对照表每行记录场景、命令和参数、样本版本、预期结果、实测结果、证据路径、已知失败与重跑结论。

### R1　标签拖放和窗格状态（首个代码包，中风险）

入口为 main.tsx 的 dropLocal、dropTab、mergeTab、focusPane；模型为 pane-layout.ts，手势数据由 tab-drag.ts 提供。先用当前入口写出插入、合并、分屏、移出最后一项及四窗格满额的行为表。把落点是否合法、目标窗格和空窗格处理放到现有布局模型；窗口负责执行原生移交、更新选择和恢复焦点。保留本地标签和服务会话不同的分组、分离与身份规则。一次失败不得留下重排了一半的树或标签序列。验收用 pane-layout.test.mjs、Test-Desktop-Split.mjs、Test-Desktop-PaneGroups.mjs，覆盖本地/SSH 混排、同窗格重排、最后一个标签、四窗格和拖动时服务换代。回退恢复原事件入口并复跑同一操作。

### R2　复制会话与结果落位（中风险）

入口为 main.tsx 的 copyTab、copyStillCurrent、beginCopy、receiveCopy、selectNewConnection，以及 session_windows.rs 的移交边界。把一次复制的原服务、会话代次、窗格、来源类型、读取中/对话框中/结果已返回的状态归到窗口内同一协调模块。DOM 锚点和焦点仍由 React 持有，源设置及原生窗口许可沿用已有检查。本地复制、主窗格复制和独立窗口移交先逐项写明差异。检查读取中关源窗格、同 ID 换代、重复点击、取消后迟到回执、打开多个候选窗格；正确结果只落一次，错误结果不能抢焦点。运行 Test-Desktop-SessionCopy.mjs 的 SSH 和内存串口场景，并用确定性测试覆盖迟到结果。回退只撤本包，保留 R1 的布局接口。

### R3　定位输入到回显的耗时（测量包）

[P26.34 同机对照](records/P26.34.md#同机对照)三组成对比较的双窗格 P95 增量为 4.0、7.4、4.5 ms；双窗空闲空读六批均为 28 次，尚不能定位原因。在隔离夹具用无内容的关联编号记录输入入队、IPC 请求开始/完成、远端合成回显、服务读页、writer 完成及可观测的 WebView 帧。跨进程时钟须校准或仅比较本进程时间段；writer 回调与屏幕实际呈现分开记录。复用输入延迟、常见路径和 P26.34 快捷指令测量入口。现有脚本测量范围各异，本包为同一次输入补齐分段关联，并用同一二进制交错比较诊断开关启闭的影响。分别测单窗格、双窗格、多窗口空闲及输出负载，固定二进制和场景、预热、交错顺序，多轮报告样本数、P50/P95 和测试失败。采样前写明预热、每批样本量、配对及波动判定办法。差值落在同机基线波动内、诊断开销达到差值量级或关键阶段缺少可比较数据时，保留未决结论。此包只交付归因证据，诊断开关默认关闭。

### R4　原生命令适配层（中风险）

main.rs 的 ssh_request 对请求枚举穷举目标，随后校验窗口并经共享服务发请求；serial_request、配置和日志入口各有独立规则。先搬移 SSH/串口命令到领域模块，保留注册名称、State、序列化和返回错误；有多个调用方需要同一目标规则时，让对应协议请求提供穷尽的目标查询。对“无已有连接目标”的启动请求、固定目标状态查询、独立窗口拒绝逐一锁定。许可检查与转发的时序、共享锁范围先维持原状。验收 Rust 定向测试、原生构建、主窗与独立窗对同一连接的可见性/拒绝、服务终止和迟到返回。日志导出和文件对话框另步搬移，禁止把不同许可约束收进一个宽泛转发器。每个领域可独立撤回。

### R5　服务握手、审计与请求分派（高风险）

server.rs 的 connection 负责限时 Hello、身份判定、审计起止及响应写入；Runtime 已有 handle_agent、handle_logging、handle_serial、handle_ssh。先沿已有函数边界拆出连接处理，保持审计 guard、请求原编号和写回顺序；随后单独提交领域分派搬移。服务仍是权限和可见性的最终判定者。用 windows_ipc.rs 及 support 用例覆盖正常连接、超时、提前关闭、无权请求、协议错误、应答写失败；逐条比较错误码、回执归属及审计终态。针对失败注入，记录实际命中点。任何审计缺项、可见范围改变都回退本步。不要同时引入新的 IPC 并发模型。

### R6　SSH 输入接纳与传输生命周期（高风险，先隔离一个职责）

ssh.rs 的 enqueue_from 在同一流程校验身份、租约、协议限制、输入指纹及请求登记；同文件 Actor 处理认证、shell 写读和结束。优先将输入接纳实现沿现有 Manager 归入 ssh 子模块，保留锁顺序及原子检查区段。按原路径对照重复编号同/异载荷、队列满、用户接管、取消/断线和旧代次回执。再评估 Actor 拆出认证处理的收益，单独提交。serial worker 的 join、取消及设备释放继续由串口服务负责。验收回环 SSH、IPC、内存串口相关定向用例及 SSH1 拒绝自动降级；记录无重放、队列边界和审计结果。若只能靠暴露内部可变状态完成拆分，停在现有边界并登记原因。

### R7　MCP 工具契约与调用一致性（中高风险）

以 live.rs 的 list_tools、call_tool 和 live/wait.rs 为基线，对每个已发布工具列出名称、入参版本、对应 Operation、错误映射和并发许可。优先复用现有 contracts/mcp 与 scripts/lib/McpCatalog.mjs 对清单和解码做一致性测试，按工具族分离纯参数转换。仅对确有重复的名称/元数据使用一个来源；独立桥身份、服务端授权、terminal_wait 的等待与取消、快捷指令两个版本的解析顺序逐项保持。验收清单逐项比对、无效参数、容量耗尽、等待缺口、取消、迟到结果；调用有副作用的测试仅走隔离夹具。回退单族即可，历史契约快照保留原文。

### R8　针对证据实施性能优化（条件包，高风险）

本轮条件判定已完成。两组历史延迟差异均未复现，分段数据未定位可重复的瓶颈，R8 未启动。[执行结论](records/P26.47.md)

R3 若显示耗时在渲染或读取，分别针对 terminal-controller.ts 的读页调度、terminal-writer.ts 的绘制做单变量试验。若主要耗时在原生锁等待，先检查 service.rs 与 session-service/client.rs 的串行假设：Client::request 取出管道、递增线编号并核对应答。简单去锁会破坏请求应答对应关系。首先试验消除重复的只读请求；确需改变连接/并发模型时，先写 ADR 描述身份、排队、超时、取消、原编号查询和回退。采用 R3 同批次成对复测；要求目标阶段改善超出同机基线波动，输出完整、空读、焦点、输入顺序及归属均通过。缺乏稳定收益则撤销实验，保留测量结果。

### R9　测试夹具整理及整体验收（低至中风险）

SessionCopy 和 PaneGroups 脚本已复用 DesktopHarness，但各自承载工具栏、面板及不同设备模式。按真实重复项把本次用到的进程启动/终止、隔离根及报告元数据收回已有 harness。保留每个脚本现有参数、退出码、失败截图/定位、原始断言和独立运行能力。只迁移两个有代表性的入口，先对比成功、故意失败和中途退出的结果，再推广其余重复项。验证普通服务拒绝测试入口，finally 恢复并核对普通服务。最后以同一候选三程序重跑跨包路径：双窗格拖放→复制→输入→移交→日志保存→关闭；再跑模拟 ADB 快捷指令、桥授权与撤销。对物理设备、实际键鼠和长稳，分别注明是否有当次证据。

## 三、验证入口

从仓库根运行，依赖和 x64 Release 构建见 [README](../README.md#本地开发)。下表的 `$releaseDesktop` 指向配套三程序目录的桌面 EXE，`$uartDesktop` 指向另一个配有测试服务的隔离目录，`$report` 每次取独立报告路径。固定并记录桌面、服务和桥的散列。带回环 SSH 的入口先准备 `target/debug/examples/gui_ssh_fixture.exe`。用测试服务时，收尾在 finally 恢复并核对普通服务、验证普通服务拒绝夹具入口。桌面脚本的当前覆盖范围及物理输入约束见[维护手册](UI_GUIDELINES.md#可用性与执行证据)，整体证据按[测试计划](TEST_PLAN.md)记录。

| 工作包 | 命令与证据边界 |
|---|---|
| R0、R1 | `node --test tests/pane-layout.test.mjs`、`node scripts/Test-Desktop-PaneGroups.mjs $releaseDesktop`、`node scripts/Test-Desktop-SessionCopy.mjs $releaseDesktop --tab-interactions`。另运行 `npm run test:desktop:split`，此入口使用默认调试桌面，由脚本构建并恢复调试服务。 |
| R0、R2 | `node scripts/Test-Desktop-SessionCopy.mjs $releaseDesktop` 和 `node scripts/Test-Desktop-SessionCopy.mjs $uartDesktop --uart`。对迟到、重复回执及焦点归属补确定性检查，逐项注明桌面专项与确定性测试的覆盖。 |
| R3、R8 | `node scripts/Test-Desktop-ShortcutRoutes.mjs $releaseDesktop --verify-reads --measure $report` 重测 P26.34 对比场景，`node scripts/Test-Desktop-InputLatency.mjs --release $uartDesktop` 检查输入路径，`node scripts/Measure-Desktop-CommonPaths.mjs $releaseDesktop $report` 测普通发布路径。输入延迟入口使用夹具服务，按实际场景标注配套服务特性。 |
| R4–R6 | `cargo test -p session-service --locked --test windows_ipc`、相关 crate 的定向用例，并按范围运行 Windows Release 专项。R4 核对主窗、独立窗及服务失联，R5 核对握手、回执和审计，R6 核对回环 SSH 和内存串口输入。测试特性按实际场景补充并记录。 |
| R7 | `npm run test:mcp`、`npm run test:desktop:mcp` 和 `npm run test:desktop:wait`。用 `node scripts/Test-Desktop-McpShortcuts.mjs $releaseDesktop $previousDesktop` 逐项比较版本化目录和旧桥兼容，旧桌面及配套桥按 [P26.26](records/P26.26.md) 的对照方式准备。 |
| R9 | 使用同一候选组合复跑跨包流程。组合路径如需人工执行，保留每次操作及断言的证据，注明物理键鼠或自动化输入，并逐项列出剩余未验场景。 |

## 四、通用验收与交付

| 影响面 | 既有入口 | 放行证据 |
|---|---|---|
| 前端模型与界面 | npm run lint、npm test、npm run build；终端变化另跑 npm run test:screen 与 npm run test:history | 路由/目标/游标断言通过，专项覆盖用户真实操作入口 |
| Rust 领域包 | cargo fmt --all -- --check；cargo test -p <crate> --locked；cargo clippy -p <crate> --all-targets --locked -- -D warnings | 列出实际 crate、特性和平台；涉及线契约时检查两端 |
| Windows 原生 | README 的 x64 Release 命令及各专项；复制同次输出的桌面、服务、桥 | 三程序 SHA-256、独立数据根、窗口和夹具身份、退出结果 |
| 数据与权限 | 隔离旧库、锁冲突、模拟导出、IPC 身份与能力用例 | 失败保留老数据与既有目标；真实凭据、文件内容及私有日志不入证据 |
| 性能 | R3 对照与 R8 同机复测 | 样本、分位数、运行顺序、完整性与失败重跑均留档 |
| 文档 | pwsh -NoProfile -File scripts/Validate-Docs.ps1；新增步骤按支持方式提供 -PendingStep | 记录、台账、链接、提交正文 Step-ID 一致，提交后无参数复查 |

每步交付：记录基线与复现 → 修改单一职责 → 执行对应门禁 → 写 docs/records/<Step-ID>.md、台账及必要的 UI/架构记录 → 明确路径暂存、检查暂存差异和 git diff --cached --check → 单独本地提交并核对状态。失败写明 IN_PROGRESS 或 BLOCKED；回退使用新增 revert 提交，复测原失败用例。需改线协议、磁盘格式、权限语义或安装布局时，先作为架构/范围变更评审并明确旧版本兼容、迁移和回退办法。

首个可交付里程碑为 R0–R2：用户可在本地及远端标签混排时稳定移动、复制、取消，且结果和焦点始终归属原目标。第二个里程碑为 R3–R7：给出回显分段数据和跨层契约对照，每个职责调整均有独立候选。最终交付以 R9 整体验收和 R8 实际处置结论为准，列出提交、候选目录、测试边界和剩余风险。

本轮已完成 [R9 整体验收](records/P26.49.md)，交付普通 Windows x64 三程序候选。严格 Clippy 检查的历史诊断、验证范围及隔离清理例外见该记录。R8 的启动判定见 [P26.47](records/P26.47.md)。
