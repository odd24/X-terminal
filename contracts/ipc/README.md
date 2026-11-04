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
