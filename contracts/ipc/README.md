# Session IPC v1

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
