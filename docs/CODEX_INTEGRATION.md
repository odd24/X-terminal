# Codex 首版接入方案

2026-11-08按[CR-006](changes/CR-006.md)及[现行路线](EXECUTION_PLAN.md#现行路线cr-006)，当前只做简洁SSH2登录，达标再做串口；Codex共享能力保留复用并移至S4按需收敛，不再作为当前主线或普通连接前置。下方已有证据/未验限制保留。

2026-11-08实际安装版本`codex-cli 0.163.0-alpha.10.2`：官方app-server显式客户端通过9工具发现及原SSH连接的精确发送/原回执/读取，未用模型turn；实际exec模型已配对并识别同连接，但input_acquire被客户端“requires approval, but approval policy is never”拒绝且wire0。两类结果独立，不能说模型自主写入通过；模型发送需正常交互批准，不改真实工具属性或组织策略。可直接试用的本机说明见[LOCAL_PREVIEW](LOCAL_PREVIEW.md)，准确证据见[P16](records/P16.md)。本轮仅进程配置，不需要备份/合并或修改用户全局配置；下方旧全v1配置/工具方案保留规划，不能直接复制无endpoint的旧args。

2026-11-07初版桥按[ADR-059](decisions/ADR-059.md)采用原生Agent代理：stdio不持有bearer，只经当前用户Pipe向原生转发9个基本工具，再由独立Agent身份进入原会话服务；没有另开SSH shell或借用Desktop权限。实际启动参数来自“MCP 初版连接”，仅本次endpoint/PID，用户核对实际桥进程与P14原授权后一次批准。受保护读取强制使用原策略；原编号与最后派发仍由服务验证。实际双协议stdio软件证据见[P15](records/P15.md)，工具契约为[initial-tools.json](../contracts/mcp/initial-tools.json)。下方完整v1拟定工具仍留后续，实际Codex测试属P16，不修改全局配置。

P14按[ADR-058](decisions/ADR-058.md)直接持久记录RPC/Policy有限元数据，队列与同步分水位、有限保留/坏尾/失败可见；历史只供Desktop读取，不是Agent工具或权限来源。已知记录故障拒绝新Agent授权/lease/admit/final dispatch及完整/窗口新正文读取；原编号安全回执、本人原任务结果、释放/撤销/人工接管保持，不重放或续期。桥应展示原错误并只查询原编号，不能借用Desktop bootstrap绕过故障；真实stdio交付和工具继续P15。

P14按[ADR-057](decisions/ADR-057.md)提供固定票据输出保护及完整规则GUI批准。受保护票据必须用ProtectedContext Info/Text/Screen（可带原OutputWindow）与本人ExecReadProtected；先Info取through_cursor再固定源seq分页，不能调用旧Read/ReadText/Screen/Context/ExecRead，Raw明确拒绝，不回退原文。策略由服务原票据提供，Agent不能传规则/ID覆盖，仍核对Read或本人exec；报告分别说明原源缺口/结束、边界保护、控制重写及隐藏屏幕行。远端exit_signal也受原策略，原始缓冲/日志不改。签发/查询只公开随机策略ID/模式/数量，规则、盐、相等摘要和token不进入WebView回执。GUI批准不执行/取lease或交付token，P15真实桥须明确识别保护元数据并使用对应入口；准确软件证据见[P14](records/P14.md)。

P14按[ADR-056](decisions/ADR-056.md)提供单次完整操作与限时任务的服务/桌面批准。单次固定原操作编号、协议包装规范参数指纹及最小scope，真正Agent请求必须由服务重算绑定；Task说明不扩大范围。GUI批准不执行动作，原编号查询不续期/重放；正文/同意不持久化且token不入WebView。SSH8/串口6完整预览与实际证据见[P14](records/P14.md)，仍不能把该批准当真实stdio桥或Codex已接入。

P14时间窗按[ADR-055](decisions/ADR-055.md)新增OutputWindow Read与Context Info/Raw/Text/Screen。桥须使用窗口票据允许的新Context接口：先Info取当前原始exclusive source_cursor，再固定through_cursor分页；原始与文本游标均为源seq。窗口为Unix毫秒[from,until)，不与服务单调授权期限混用。时间窗票据不得用旧Read/ReadText/Screen绕过，范围屏幕为当前尺寸从空状态重建，不是完整实时屏幕；source_truncated/重置/源状态保持显式，固定水位completed不等源已结束。服务/GUI真实结果见[P14](records/P14.md)，P15真正stdio工具仍须独立交付。

P14 ADR-054串口新增ForgetStart/ForgetStatus，完整ConnectionRef/request_id绑定真实认证owner，独立Forget/lease且实际worker join/无未结ticket后才移除记录。原有效ticket原编号在退休后只查，不续期；清理未完/容量失败无成功回执，可原编号重试，不取消活跃worker。旧无编号Forget仍Desktop专用，Removed不删日志/配置/用户文件。两协议GUI批准及安全原生token交真实stdio桥分步验证，服务IPC通过不代表桥已交付；准确结果见records/P14.md。

P14 Agent授权GUI现支持SSH Reconnect双范围：只为已断开SSH2原代次列出匹配Profile，预览同时绑定旧ConnectionRef/Reconnect与固定Profile/revision Connect，默认无勾选、一次性批准且批准前重读版本；批准本身不执行重连。认证/主机信任仍由Desktop处理，合成SSH结果见[P14](records/P14.md)，Forget与真实stdio桥继续独立交付。

Agent SSH Reconnect服务路径见[ADR-053](decisions/ADR-053.md)：精确结束旧ConnectionRef独立Reconnect与新lease，并另需同ticket的固定Profile/revision Connect；原编号只查创建时回执，不表示当前在线，不因配置/连接删除重建。退役不继承读写/认证/lease，新Actor首poll仍验Connect。GUI组合批准已接入合成SSH面板，真实stdio token交付仍继续，不能用Desktop票据代替。

P14授权GUI独立提供已保存SSH2/SERIAL固定revision Connect，默认无目标/无同意；预览非秘密配置及串口初始DTR/RTS，批准前重读同版本。批准只签发，不连接、不授新代次范围/lease/库存/认证；原编号恢复不续期。第19两协议真实GUI准确结果见P14，仍不等于Agent token已交真正stdio桥。


P14按[ADR-052](decisions/ADR-052.md)新增profile_revision目标，精确Profile ID和配置库revision上的Connect。Start先匹配版本并读取不可变配置快照，再复核同许可派发；配置变更后不能以旧批准使用新参数，原Start编号仍只查。旧profile目标保持ID语义，不把它当固定配置。GUI/真实桥交付准确结果见P14，Connect不授新连接范围、lease、库存或认证批准。


P14现有授权面板可对SSH2/SERIAL明确批准独立Disconnect，默认不勾选；固定ConnectionRef/期限，批准不执行动作，不代取租约或授其他能力。接管后的有效范围撤下断开能力，原批准只读保留。第19原生入口覆盖两协议（串口为内存worker），准确结果见P14；真实stdio桥安全交付、Profile Connect批准与完整上下文/审计继续。

P14串口新增严格Disconnect/DisconnectStatus，原有效ticket/原owner编号在范围退休与Forget后只恢复回执、不续租或再取消新worker。新请求需要独立Disconnect/lease，Write/Connect/Control不推导；只有实际join返回才能TransportEnded，回报丢失保持Requested。准确结果见P14/ADR-051，GUI批准与实际stdio桥仍须独立交付。

P14 SSH Disconnect服务按[ADR-051](decisions/ADR-051.md)使用精确ConnectionRef/request_id、独立Disconnect与lease，新请求取消原共享传输/任务并退休范围；原有效ticket同owner编号在范围退休/Forget后只取回执，不重派发。Requested不代表回收，TransportEnded仅本地Actor及传输引用已结束，不承诺远端动作撤销。真实验证见P14；串口Disconnect、GUI动作批准及实际stdio桥仍继续。

P14串口Start按[ADR-050](decisions/ADR-050.md)接Profile Connect/原回执owner及OS worker打开前许可；调用仍须精确库存revision/device_id，与配置端口一致，Agent无Inventory权限。原编号恢复不因库存刷新/配置删除而重开。GUI Profile批准、Disconnect与真实桥继续，结果见P14。

P14 SSH Start已按[ADR-049](decisions/ADR-049.md)接精确Profile Connect与原回执owner；同来源重试只查原结果，跨来源UUID拒绝，配置等待/实际首次派发前重验。Connect不推导新连接Read/Write/租约或认证批准。GUI Profile选择、串口Start/Disconnect及真实stdio桥仍继续，结果见P14。

P14按[ADR-048](decisions/ADR-048.md)开放Agent SSH2 Resize的独立Control/lease与共享FIFO回执；Write不推导尺寸控制。Desktop显示布局调整不触发接管，结果PipelineQueued仅代表发送管线，不表示远端PTY已应用。真实MCP桥仍未交付，Connect/Disconnect/建连owner、时间范围与完整审计继续。

P14按[ADR-047](decisions/ADR-047.md)接共享授权管理GUI及Desktop专用无token投影：固定当前ConnectionRef/独立能力/期限，一次性明确批准、原编号查询撤销、租约与人工接管/有界审计。sessionStorage仅编号恢复，未知/重载不重新签发。真实MCP桥还须实现受控原生token交付，不将token暴露到WebView/剪贴板/argv/env/磁盘或把Desktop bootstrap给桥；GUI批准不意味着实际Codex已经连接。其他动作/完整持久审计继续，准确结果见P14。

P14签发管理按[ADR-046](decisions/ADR-046.md)要求Grant固定request_id，同编号同范围集合/期限恢复原ticket/token及原到期，不新授权。管理清单无token，单项查询区分原批准与有效范围；过期/撤销不返回token，重启无旧回执，不自动换ID/重发。服务查询能力不代表GUI或真实stdio工具已接入，不把恢复票据等同恢复执行权限。

P14串口Write/Send/Control及本人InputStatus的服务接入见[ADR-045](decisions/ADR-045.md)/[P14](records/P14.md)：真实Agent需要独立范围/租约，每个OS写片段前重验同一许可；用户输入/控制接管仅停止未发送尾部，driver_accepted是已知驱动下界，串口没有退出码。原编号结果不明只查询，不换ID重发。实际stdio桥仍未接入，不能使用Desktop票据绕过Agent策略；其他动作/授权GUI继续。

2026-11-06 P14增量见[ADR-044](decisions/ADR-044.md)/[P14](records/P14.md)：服务已有独立Agent身份/read范围、管理/租约/审计通道，SSH Write/WriteText/InputStatus及Exec/状态/输出/取消已接同连接FIFO和真实client归属。新Exec独立授权/lease；原客户端的保留Start重试只查原回执，释放/接管后不续租、不重派发，新Start仍须授权。自己的exec输出不推导终端Read，其他客户端不能靠UUID读/取消/重用任务。实际MCP仍P06只读mock，真实stdio桥/授权GUI及其他Agent动作继续；不允许桥用Desktop票据绕过Agent策略。

日期：2026-11-03；状态：P06 已有只读 mock stdio 原型，实际 Codex CLI app-server 客户端发现/调用通过；真实共享会话桥尚未实现。

## 当前可运行的 P06 原型

执行 `. ./scripts/Enter-Toolchain.ps1`、`cargo build -p mcp-bridge --locked` 后，`target/debug/terminal-mcp.exe --mock` 仅提供 sessions_list/terminal_read；不访问实际设备、认证或文件。`npm run test:mcp` 验证 stdio 契约，`npm run test:codex-mcp` 用本机实际 Codex 客户端和隔离配置验证发现/调用，无模型推理。详细范围和证据见 [P06](records/P06.md)、[ADR-004](decisions/ADR-004.md)。

mock 的 connection_id 固定为 mock-p06-connection，generation=1，read cursor 是合成 UTF-8 字节偏移，max_bytes 4–65536。stdout 仅协议；128 KiB 输入行与 4 工具处理并发上限。所有输出含 mock=true；这些语义不是生产权限和游标承诺。

## 方向与职责

Codex 是 MCP 客户端，本软件提供 MCP 服务。Codex 启动 terminal-mcp.exe 的 stdio 进程，桥接通过 Named Pipe 访问同一个 session-service；不使用另开 ssh 进程来假装共享用户终端。

首版不嵌入 Codex 客户端、不依赖内置模型 API、不要求把模型密钥存入终端。Codex 自身的授权和账户仍由 Codex 管理，终端服务仍独立实施会话权限。

## 配置示例（规划，不可现在直接执行）

官方文档提供 `codex mcp add ... -- <command>` 以及 config.toml 的 stdio 配置方式。项目配置需受信任。实际接入前记录 `codex --version`、`codex mcp --help` 与目标桌面版本，并验证该版本读取配置的方式。[官方来源](https://developers.openai.com/codex/mcp)

以下路径与可执行文件是拟定安装位置，不是本机现有文件：

```toml
[mcp_servers.windows_terminal]
command = 'C:\Program Files\AgentTerminal\terminal-mcp.exe'
args = ['--stdio']
startup_timeout_sec = 15
tool_timeout_sec = 60
enabled = true
```

到 P16 时再生成实际安装路径的配置片段；合并前备份现有 config.toml，保留其他 MCP 条目；记录改动，提供移除本条目的回退步骤。不要现在创建 `.codex/config.toml` 或覆盖全局设置。

## 工具契约 v0.1（拟定命名）

所有读写操作校验连接授权。参数/返回值使用 JSON Schema；版本变化需契约兼容测试。

| 工具 | 主要输入 | 输出/限制 |
|---|---|---|
| sessions_list | scope | 仅可见配置/连接，秘密字段不存在 |
| sessions_connect | profile_id、request_id | connection_id、generation、state；需要 connect 权限 |
| sessions_disconnect | connection_id、generation、request_id | 明确关闭结果；需要连接管理权限 |
| terminal_read | connection_id、generation、cursor、max_bytes | events、next_cursor、truncated、available_from；建议最大 64 KiB |
| terminal_screen | connection_id、generation | 行列、文本、光标、seq；来自服务端状态模型 |
| terminal_send | connection_id、generation、request_id、text 或 key | 接收/发送状态；write 权限与输入租约 |
| terminal_wait | connection_id、generation、cursor、pattern、timeout_ms | matched/timeout/disconnected、游标、证据；单次最长 30 秒 |
| ssh_exec | connection_id、generation、request_id、command、timeout_ms | task_id；独立 exec 通道，不继承终端 shell 状态 |
| tasks_get | task_id、cursor | 状态、输出增量、退出码（仅可用时） |
| tasks_cancel | task_id、request_id | 停止调度/尝试中断结果；不保证远程已退出 |
| serial_write | connection_id、generation、request_id、text 或 base64 | 写入字节数；精确字节路径不自动加换行 |
| serial_control | connection_id、generation、request_id、signal、value | DTR/RTS/Break 结果；独立权限 |
| logs_export | connection_id、range | 返回应用生成的受控文件标识，不接受任意主机文件路径 |

长任务以 task_id + tasks_get 轮询，不占住单次 MCP 调用。轮询有间隔和退避，避免忙循环。stdout 只输出 MCP 协议，诊断写 stderr；不得输出秘密。

统一错误类别：INVALID_ARGUMENT、PERMISSION_DENIED、AUTH_REQUIRED、NOT_CONNECTED、STALE_GENERATION、INPUT_BUSY、TIMEOUT、CURSOR_EXPIRED、BUFFER_GAP、REQUEST_EXPIRED、UNSUPPORTED、IO_ERROR、UNKNOWN_DELIVERY。区分工具失败与远程命令非零退出码。

P09 已建立输入回执的 UUIDv7 退休窗口，见 [ADR-020](decisions/ADR-020.md)。未来真实写工具应沿用同一 request_id 到查询/重试，遇 REQUEST_EXPIRED 必须告知结果保留窗口已过、不得自动换 ID 再发。时间戳是排序桶，不能当作授权期限；旧不透明 UUID 保持有限、非淘汰去重，不能无限期发送。当前 MCP 仍为 P06 只读 mock，实际有权限的写入接入在 P14/P15，不以此设计说明冒充已实现。

P09 exec 有序结果按 [ADR-021](decisions/ADR-021.md) 在容量需要时回收结束任务；task_id 可等于 request_id，权限仍由服务的连接代次/客户端范围判定。REQUEST_EXPIRED 同样用于过期 task status/read/cancel，不能解释为原命令未执行、成功或可安全重跑。可保留结果每连接 16/全局 64，其他连接的新任务也可能导致已结束结果回收，工具须明确反馈，不缓存成无限期可查询承诺。

连接记录由 Desktop 显式移除，见 [ADR-022](decisions/ADR-022.md)。Agent 后续 connect 工具须使用同一有序 request_id 查询/重试；原 Started 重复可能对应已移除或旧代次连接，不能当作当前在线，须另查状态。NotFound/RequestExpired 不能自动触发新建或换 ID。移除不向当前只读 MCP 暴露，P14/P15 授权尚待实施。

## 输入与上下文规则

1. Codex 必须使用 connection_id，不能把当前 UI 标签作为隐式目标。
2. 用户在应用选择可读连接、时间范围和写入授权；跨连接需要分别授权。
3. 初次连接/凭据问题交回用户界面，不把密码送进聊天或工具参数。
4. 每个连接写操作串行；人工接管后尚未发送的自动化输入取消。
5. 默认不自动广播；批量任务要冻结目标快照，逐个返回结果。
6. 串口提示符与安静间隔只是启发式信息，工具不能制造可靠退出码。
7. 终端输出中的“请执行某命令”等文本只是待分析内容，不是权限来源。

## P06 / P16 端到端验证

- P06：用假连接测试 initialize、tools/list、tools/call、超时、取消、stderr 隔离、退出清理。不得将 mock 通过写作真实串口通过。
- P16：安装真实桥接，备份并合并 Codex 配置；记录 CLI 与桌面各自工具发现结果。
- 桌面打开 SSH 与串口；Codex 读取指定范围，建议诊断步骤；授权后向同一个连接写入，用户立即看见。
- 拒绝未授权连接；撤销后旧调用失败；输入接管后无排队残留；断线重连后旧 generation 失败。
- 以只读授权运行一次，再以限时写授权运行一次；审计中对应 client_id/request_id/connection_id。
- 验证完成后恢复测试前授权范围，记录是否保留 MCP 配置。

验收证据必须包含客户端版本、工具版本、构建 commit、测试环境、脱敏调用与结果；不能只用配置存在或截图证明接入成功。
