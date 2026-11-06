# Session IPC v1

2026-11-06 P14新增agent管理/所有权命令族，见[ADR-044](../../docs/decisions/ADR-044.md)/[P14](../../docs/records/P14.md)。Desktop签发独立范围及期限，真实Agent身份可读取明确read范围；授权/租约/撤销/接管/审计按服务端身份校验。旧SSH/串口控制、配置/日志/认证仍Desktop专用，FIFO与worker派发许可尚须接入，不能把完整scope或lease回执当Agent写工具已开放。以下早期阶段描述保留历史，实际新契约以生产schema/当前步骤记录为准。

P07.1 定义，P07.2 已实现原生 Windows 承载。每帧 u32 little-endian 长度 + UTF-8 JSON，1–524288 字节；正常 EOF 不等于部分头/主体。连接建立后首帧为 Hello，成功响应 id=0 的 welcome，然后发送带 u32 id 的 RequestEnvelope。请求串行、响应回显 id；角色不能由客户端声明。

固定 schema：[v1.schema.json](v1.schema.json)，三个入口 hello/request/response。生成：

```powershell
. ./scripts/Enter-Toolchain.ps1
cargo run --quiet --locked -p session-protocol --example schema | Set-Content -Encoding UTF8 contracts/ipc/v1.schema.json
cargo test -p session-core -p session-protocol --locked
```

Hello 包含 protocol_version=1、1–64 UTF-8 字节的非控制字符 client_name、64 位十六进制 token。运行时验证与 serde 拒绝未知字段共同实施边界；schema 不代替票据/代次/状态检查。bootstrap 不进入 argv/env/renderer；帧正文与 token 禁止记录到诊断日志。

当前 Request：ping/list/read、桌面签发/撤销观察票据、显式测试 fixture 的 create/append/reconnect/close/remove、桌面 shutdown。fixture API 默认不可用，不打开设备；真实设备操作在后续步骤通过统一服务/调度接入。没有“默认当前 UI 标签”目标。

P08.3 开发增量加入 config 请求，只有 active Desktop 可用，Observer 查/写均拒。包括分页、目录/Profile 保存删除；SaveProfile 输入无 credential_ref，凭据 Keep/Clear/Replace 由服务查旧引用或分配新 ID，没有读秘密操作。ConfigReply 错误为固定类别，不包含秘密/SQL/路径。每页最多 64 项，后续页必须携带 revision，修改/重启后 Conflict；不能将不同 revision 拼为快照。配置需本地启动参数 --data-dir 绝对路径显式启用，缺省 Unsupported；IPC 不收任意文件路径。详见 [ADR-010](../../docs/decisions/ADR-010.md)，桌面/主机密钥/备份恢复仍在实施。

read 的 connection 必须明确 connection_id/generation；cursor 为下一事件序号、起点 1，max_bytes 4096–65536。响应 OutputPage 包含该连接代次、原始 bytes 事件、next_cursor、available_from、truncated 和 disconnected。覆盖导致缺口时客户端必须显示并重新建立解码状态，不能悄悄将截断控制序列接在一起。新代次重置事件序号，旧游标不能跨代次复用。

观察票据限 30 分钟、绑定精确连接代次，撤销/到期必须逐请求重新校验；P14 再加入生产 Agent 写权限。当前契约是本地开发 v1，不表示 P15 MCP 工具或所有设备能力已经完成。

原生入口为 `session_service::client::Client`，根据当前用户 SID 和受限 instance 名确定本机端点，必须提供预期服务 PID，发送票据前检查。服务 bootstrap 经父进程匿名 stdin 帧传递，禁止 argv/env/明文配置文件。默认禁止所有 fixture 操作；仅 `--test-fixture` 启用合成生命周期，不是实际终端会话。测试命令 `cargo test -p session-service --locked` 会启动临时子进程并在结束时清理。

P08.3 桌面增量加入 Desktop 专用 save_profile_key_file：输入 Profile、绝对本地私钥文件路径和可选敏感口令；服务限额读取普通文件/PEM 头后保护，回复只给配置引用。设备/UNC/ADS/保留名/超限拒绝。它不返回文件内容，不向 Observer 开放；Tauri 通用保存拒绝 renderer 直接提交私钥材料。真实 SSH 私钥解析/认证由 P09 验证，当前契约不把保存当作认证成功。

host_keys_page/forget_host_key 也仅限 active Desktop。每页最多 64 项，返回公开摘要而非私钥；删除携带 endpoint/algorithm/expected_fingerprint，旧指纹 Conflict，不自动重试。renderer 不提供任意批准信任记录的命令，实际握手确认由 P09/P13 处理。

P09 开发增量加入 ssh 请求：Start(profile_id/request_id/cols/rows)、Status、AnswerHost、Authenticate、AnswerInteractive、Close。全部仅 active Desktop 可用；Observer 对该命令族拒绝，仍可凭既有只读票据读实际 SSH2 OutputPage。Start 同 request_id/参数返回同一原始 connection，参数冲突拒绝，服务结束后不恢复请求或票据。

其余 SSH 操作明确 connection_id/generation；回答还须当前 challenge_id，回执消耗一次，错误类型/重复/关闭后/旧代次均拒绝。HostKey 挑战只携带当前公开 review，服务保存实际握手 candidate 和信任 revision；客户端不能提交任意待批准密钥。Authenticate 选择 use_saved 或临时 password，禁止两者并存或原始 key 字段；公钥使用启动 Profile 的受保护引用，启动后配置变化拒绝取用。KeyboardInteractive 返回 name/instructions/prompts 与 echo，不将远端文字解释为权限或工具指令。

当前服务阶段仅建立/认证/读取 shell 与关闭；写入、尺寸更新、exec 任务、重连及 GUI 尚未接入。Status 保留失败类别、待确认挑战和可选 shell_exit_status/shell_exit_signal，缺退出码不编造成功；TransportTimeout 和 ApprovalTimeout 区分协议操作与用户等待。该开发契约扩展不代表 R01 或 v1.0 验收完成。详见 [P09](../../docs/records/P09.md)。

P09 输入增量：ssh/write、resize、input_status 都要求 connection_id/generation/request_id，仅 Desktop；Write 的 bytes 是最多 65536 项非空字节数组，Debug 脱敏。相同 request_id/相同内容返回已有回执，不再次发送；内容或动作冲突拒绝；队列满 CapacityExceeded 且不登记已接受。Input 回复的 request_id/state/pipeline_bytes/failure 不带输入内容。

状态包括 PENDING、DISPATCHING、PIPELINE_QUEUED、UNKNOWN、CANCELLED_BEFORE_DISPATCH。PIPELINE_QUEUED 只表示 SSH pipeline 接收了调用，绝不表示远端执行；resize 的 pipeline_bytes 为 null。UNKNOWN 可能已有部分字节发送，关闭/超时不重放；尚未调用底层的队列项为 CANCELLED_BEFORE_DISPATCH。可在关闭后查询既有回执；旧代次拒绝。每代最多 1024 回执且不淘汰，长期策略留 P14/P22，详见 [ADR-015](../../docs/decisions/ADR-015.md)。

P09 exec 增量：exec、exec_status、exec_read、exec_cancel。启动输入 connection_id/generation/request_id、敏感 command、timeout_ms(1–86400000)、max_output_bytes(1–1048576)，命令至多 64 KiB、非空/无 NUL；相同 ID/参数返回同 task_id，动作/参数冲突拒绝。全部仅 active Desktop，现有 Observer shell 票据不授权任务输出。

任务为 QUEUED/RUNNING/CANCELLING/FINISHED；状态和输出回复均带明确连接/task_id。exec_read 从 cursor=1 开始，每次 4096–65536 bytes，上限 64 KiB/128 事件的独立 stdout/stderr 缓冲覆盖时 truncated=true 并给 available_from，不混入交互 shell 输出。摘要单独保存 exit_status/exit_signal/request_accepted（可能 null）、总输出字节和结束原因；非零 code=7 也可为 COMPLETED，缺码/超时/取消/断线不伪造 code=0。CANCELLED_BEFORE_DISPATCH 才表示未派发，其余取消不承诺远端动作撤销。exec 不继承交互 shell cwd/环境。

启动走相同服务 FIFO，派发后独立运行。活动上限每连接 4/全局 16，保留结果每连接 16/全局 64，不淘汰去重证据；满额 CapacityExceeded。长期清理/容量及 Agent 权限/任务体验仍待后续，详见 [ADR-016](../../docs/decisions/ADR-016.md)。

P09 reconnect 增量仅从 DISCONNECTED/FAILED 接受当前 connection_id/generation/request_id/尺寸；活动连接先显式 Close。保持 connection_id，generation+1，并重建输出/挑战/输入/任务，不重放。读取当时的最新 Profile 快照，新端点或变化主机需重新确认，认证须新回答；旧票据不自动获得新代次。

相同 Reconnect 来源和参数/request_id 返回原 Started 结果，并发只迁移一次；参数/动作冲突拒绝。同源不同 request_id 竞争只能一个成功，另一方 StaleGeneration。重复响应中的 state 是原始响应而非当前状态，应另查 Status。Profile 已删除或改为其他协议则拒绝，不递增代次；当前表不迁移旧任务/输出历史，旧代次查询明确拒绝。详见 [ADR-017](../../docs/decisions/ADR-017.md)，GUI/审计/长期容量仍待后续。

后续容量增量以 [ADR-020](../../docs/decisions/ADR-020.md)/[ADR-021](../../docs/decisions/ADR-021.md)/[ADR-022](../../docs/decisions/ADR-022.md) 为准：输入/结束任务/结束建连回执的有序退休水位替代满额后的永久拒绝，旧不透明 ID 仍不可回收，RequestExpired 不表示动作从未执行，不自动换 ID 重发。

Desktop 专用 ssh.forget 只接收完整 ConnectionRef 并返回 accepted，仅 DISCONNECTED/FAILED 当前代次可移除，丢弃其保留输出/输入/任务，保留配置/凭据与独立 Start/Reconnect 去重。移除后 status/read 返回 NotFound；保留中的建连重复仍返回原 Started（不是新建），回执退休后旧 Start/Reconnect 返回 RequestExpired。连接最多 64、建连回执最多 1024，活动当前代次回执及 opaque 回执不回收。移除与重连竞争只允许一个在原代次成功，不支持 force 或隐式当前连接。

P10 增加 serial 请求，见 [ADR-025](../../docs/decisions/ADR-025.md)：active Desktop 的 inventory/start/status/write/control/input_status/close/forget；观察者仍用公共 list/read。start 只接受 Profile/request_id/枚举 revision+device_id，不接受原生路径。串口写入/控制明确 ConnectionRef/request_id，回执分 PENDING（可能已派发）、DRIVER_ACCEPTED、CONTROL_APPLIED、UNKNOWN、CANCELLED_BEFORE_DISPATCH；成功驱动调用的字节计数是下界，不是设备执行/退出码。关闭排空并 join 后才发布终态，之后才能移除/再次手动打开；当前再次打开使用不同 connection_id，不继承旧权限。

OutputEvent 可选 gap_bytes 表示接收端已丢失字节，该事件 bytes 为空且有独立 seq/时间戳；普通字节事件省略字段。truncated 仍表示消费者落后导致保留历史覆盖，不能替代源头接收缺口。客户端必须显示/传递 gap_bytes，不得无声拼接；本开发增量随服务/客户端一同构建，不声明旧严格客户端跨版本兼容。

P10 serial.send接收connection/request_id/content/format(text|hex)/ending(none|cr|lf|cr_lf)/pace(chunk_bytes,interval_ms)。编码取打开时快照；文本不可表示拒绝，HEX只数字/ASCII空白，最终最多64KiB含末尾换行，内容UTF-8最多196608字节。整批一个FIFO元素，段1–1024、间隔0–1000ms、计划间隔总计60秒；返回串口Input回执，未知/取消不重发。Status增加encoding/hardware_rts，硬件流控的RTS服务层拒绝。见[ADR-026](../../docs/decisions/ADR-026.md)。

P11.2增加公共read_text与screen，沿用read的can_read范围/到期/撤销/代次检查，不允许读者指定编码或路径。read_text从独立cursor=1读取，每页UTF-8文本预算16384–65536字节；TextEvent的seq为文本序号，source_seq对应原始事件（最终flush为null），timestamp_ms沿用原始事件/最后输出（无输出为0），text可为空，decode_error表示此事件解码替换，gap_bytes为源头丢失。completed表示生产结束，不表示本页已含全部尾部，需沿next_cursor读到空页；source_cursor为服务派生至原始的下一事件位置，不是本页尾部。文本256KiB/128事件，独立覆盖truncated与available_from，不能当作原始字节窗口。

screen返回编码、parser、resize_reflow、尺寸/光标/替代屏幕、source_cursor/completed、接收gap_bytes与decode_error_events。contents最多64KiB UTF-8，截断时contents_truncated=true。当前parser=vt100-0.18.1+local.1、resize_reflow=false，宽度变化不重排且复杂组合/真实程序兼容仍待验；不是桌面截图或完全一致承诺。源缺口重建字符与终端解析状态，保留历史覆盖仅影响落后读者，不重置服务screen。详见[ADR-028](../../docs/decisions/ADR-028.md)。这是同构建开发契约扩展，schema与客户端必须同步更新。

P11.4启停阶段增加logging族，全部active Desktop专用：start(connection/request_id/limits)、list(connection)、status/stop(connection/log_id)。limits.segment_bytes为128KiB–100MiB（每对raw/text总和），segments为1–16；无路径/编码/角色字段。Start仅当前CONNECTED代次，相同ID/参数返回原log_id及现状态，冲突拒绝；旧Start不会在重连后新建。Stop幂等、核对日志自身ConnectionRef，不能解除别的capture_id。List当前只枚举本次服务注册的该精确代次日志，不冒充持久历史扫描。

Info包含元数据、限额、OPENING/RECORDING/STOPPING/STOPPED/FAILED、active捕获标志、accepted/written/rejected计数、已接受source_gap_bytes、最后成功的分段范围/退休数、natural_end、durable和worker_finished。停止响应不等于同步完成；natural_end指最终解码flush，包括FAILED收尾，不是退出成功。目录/Start回执/日志注册分别限64，满额拒绝新增；持久历史、读取/导出和容量整理继续后续阶段。见[ADR-030](../../docs/decisions/ADR-030.md)。

P11.4新增logging/history_list、history_open、history_read、history_close，服务器全族仅active Desktop；Observer的当前会话read票据不授权持久日志。history_list为受管理根最多64个UUID目录的可信本地目录展示，无调用者路径；HEADER_CHECKED只保证文件政策/元数据头，UNFINISHED/INVALID/UNAVAILABLE不带推测身份。完成标志引用缺失文件归INVALID。history_open绑定精确ConnectionRef/log_id/read_id，返回声明范围/保留起点，未验证全部内容。

history_read显式同一范围和cursor，1–128条、32–64KiB逻辑负载并额外检查真实编码帧；返回原始事件/TextEvent配对，next_cursor仅越过交付记录，只有finished=true表示保留范围全检通过。一个reader保留最近页，相同cursor及限额重试返回同页，改变参数InvalidArgument，旧于缓存RequestExpired，超前InvalidArgument。history_close立即释放句柄和页缓存，重复关闭保留回执时幂等；关闭/120秒闲置/损坏后的read_id不可重开。8个reader、16队列、128回执，UUIDv7已关闭回执按水位退休；不透明ID固定保留，满额CapacityExceeded。阻塞文件系统期间不保证准时到期。旧代次历史读取不隐式连接/发送/重放任何命令。

目录路径由配置线程持有数据目录所有权时提供，SQLite损坏不屏蔽已完成日志，目录被另一服务占用仍拒绝；服务退出释放全部句柄。当前桌面只具日志启停UI，历史浏览/搜索/导出UI继续P11.4，不以IPC存在推断界面或整日志恢复完成。

P11.4增加logging/export_start、export_status、export_cancel，均active Desktop专用，要求精确ConnectionRef/log_id/request_id，不接受路径/角色。Start按完整作用域去重，返回result=export及ExportInfo；独立文件线程、8队列、64本次服务回执，满额CapacityExceeded。相同ID不同范围InvalidArgument；不存在回执NotFound，失败/取消/完成重试均不重跑。任务与8项磁盘导出尝试配额独立，不隐式清理。

phase为QUEUED/RUNNING/CANCELLING/COMPLETED/CANCELLED/FAILED，failure为INVALID_SOURCE/CAPACITY/TOO_LARGE/STORAGE/WORKER_FAILED或null；bytes/retained_records/retained_raw_bytes/retained_gap_bytes/next_cursor仅COMPLETED提供，否则null。COMPLETED表示保留范围已全检并同步、不覆盖发布到受管理存储，不保证原连接完整、远端命令成功或用户自选位置已保存。CANCELLING不能作完成；发布成功优先于晚到取消。取消/查询直接访问回执，不等待文件队列。重启不恢复回执或授权，同ID既有目录禁止覆盖；新ID仍可从无活动连接的历史日志生成。协议schema由例程重生成，本开发扩展要求服务/桌面/桥接同构建。

P11.4增加logging/cleanup_list(kind)、cleanup_preview/status/cancel(kind,id,preview_id)、cleanup_commit(kind,id,preview_id,confirmation)，kind=LOG/EXPORT，UUID非空，拒绝路径/自报文件集合/role/recursive。全部仅active Desktop，list/preview/commit另外核对目录所有权；损坏文件也仅按明确UUID维护，不猜造ConnectionRef或授予观察者维护权。目录列表最多64个UUID，不读内容/不保证完整；导出枚举不创建缺失根或争抢写入者锁。

返回result=cleanup_list(kind,ids)或result=cleanup，后者含原kind/id/preview_id、phase=PREVIEW/CANCELLED/EXPIRED/APPLIED、expires_at_ms、confirmation（仅PREVIEW非空）、固定文件名/逻辑大小及report。独立8队列、4快照、128回执，快照30秒有效，查询不续租；取消/到期只释放。提交必须回传原确认码，作用域/码不符InvalidArgument，到期/取消后提交RequestExpired；相同已提交ID+码返回原报告不再次删除。APPLIED不等于清理成功：report包含removed_files/removed_logical_bytes/directory_removed/failure(CHANGED|STORAGE|null)/os_code，途中失败按实际前缀报告且不可回滚，新增未知项不删除。重启不恢复旧确认，不能用旧提交重建预览。

快照或排队保留意图期间新的日志/导出Start及历史目录/新开读取明确InvalidState；其他终端输入/输出不受文件锁影响。存在排队/执行中导出时不接受新整理快照。受影响的本次捕获/导出状态新增REMOVED：捕获durable=false、active=false且计数为历史；导出成功计数全部null，不再返回可用路径。已结束且仍挂接的旧失败capture仅按精确ID解除。64条创建回执满额时只退休符合ADR-031条件的UUIDv7，旧编号RequestExpired；opaque不偷删；物理配额不扩大。schema与服务/桌面/桥接必须同构建。此阶段没有GUI整理确认入口，现有导出面板仅识别整理后的状态。

后续已接入桌面显式清理确认与本次服务失败维护。logging/capture_list为严格无参、active Desktop专用的内存清单，最多64项Info/List，包含旧代次/已移除连接而不扫描目录；Observer持read票据仍无权。logging/release_failed要求原ConnectionRef/log_id，仅FAILED且worker_finished可幂等解除关联并标RELEASED，失败计数/文件保留，不表示已清理；有序回执退休和REMOVED优先规则见ADR-031。服务重启清单为空，不自动恢复旧注册或启动记录。

P11.4导出Info新增sha256：仅COMPLETED为64位小写十六进制SHA-256，其余阶段（含REMOVED）为null。指纹在实际JSONL生产写入时累计，最终flush/sync/发布成功后才返回，不写入文件自身、不改变JSONL v1。它绑定同一可信本次服务导出scope及bytes，不能作为读取票据、任意路径授权或用户目标已保存证明。前端缺失/非法指纹拒绝成功结果；后续原生保存通过固定源句柄和两遍核验使用它，方案与边界见[ADR-032](../../docs/decisions/ADR-032.md)。本阶段尚无目标路径/自选保存RPC，不扩大Observer/Agent权限。

## 显式恢复读取（ADR-034）

Desktop专用logging增加recovery_list/open/read/close，不能由Observer只读票据调用，也未向MCP开放。列表只检查最多64项受管理UUID目录的文件政策/首配对头，返回log_id及可空RecoveryInfo（含精确ConnectionRef、捕获起点、可见起点/段范围、标志是否存在）；info=null不可拼接范围发读，头部通过不代表记录已全检。

Open/Read/Close均要求connection/log_id/read_id；Read另要求cursor>0、1–128条、32–64KiB逻辑页，无任意路径/角色/修复/跳坏行参数。同ID不同scope拒绝，同Open不重开，最后一页相同参数可精确重试，旧页/改变参数拒绝。RecoveryPage包含原scope、请求及下一游标、可见起点、records和可空stop(kind/segment/next_cursor)，没有finished；首处错误保留本页此前已验证记录，EndOfAvailable也不表示完成/同步。

复用history独立文件线程16消息队列，恢复单独4reader/64回执，普通历史8/128保持，合计12/192上限。120秒单调空闲回收或显式close释放所有句柄/缓存但保留ID；有序关闭回执可按时间水位退休，不透明ID不自动删，旧ID不能重开。服务重启只保留源文件，不恢复本次reader/回执/授权；新ID须显式新开。整理预留拒绝恢复list/open，句柄占用拒绝实际整理；恢复不会接管/写入当前会话。普通History/Export完整性检查不会自动降级，恢复GUI/未完整导出另行实现。

## 显式恢复导出服务任务（ADR-035）

Desktop专用logging增加recovery_export_start/status/cancel，请求只含connection/log_id/request_id，无mode/path/role/sha256/恢复统计等参数。操作名固定任务Mode，首请求绑定模式和精确作用域；同ID不同模式/范围的Start/状态/取消均InvalidArgument，普通导出失败不自动降级。Observer即使持匹配源的只读票据也PermissionDenied。

返回result=recovery_export，包含connection/log_id/request_id/phase/failure/incomplete/bytes/sha256/recovered，incomplete始终true；仅COMPLETED有长度、64位小写生产SHA-256及RecoveryExportSummary（recovered_records/recovered_raw_bytes/recovered_gap_bytes/next_cursor/stop）。COMPLETED只证明显式未完整产物同步发布，END_OF_AVAILABLE也不表示源完整；QUEUED/RUNNING/CANCELLING/CANCELLED/FAILED/REMOVED产物字段为null。原普通ExportInfo形状保持，不能把恢复ID经普通export_status取得“完整”回执。

两种模式共用原export worker/8队列/64回执/有序退休水位与磁盘8项/256MiB尝试，不增加容量；状态/取消不等待磁盘。晚取消以已经发布为准；清理共享注册将恢复任务标REMOVED，撤下恢复统计/长度/指纹，保留模式，旧Start不重跑/不转模式。不透明ID不自动回收；重启不恢复回执，也不覆盖同UUID残留目录。真实Windows IPC和原生通道证据见P11.4；恢复导出/另存按钮尚未从通道测试推断完成。

Desktop专用配置偏好沿用revision保护，terminal_palette必填且仅follow_theme/black_green/black_white，拒绝未知/缺失字段；旧schema 2/3仅在服务存储读取兼容，IPC不偷偷补缺省。数据库迁移前备份/摘要恢复与回退见ADR-043及P12，不开放通用路径/Agent配置权限。
