# Session IPC v1

P07.1 定义，原生 Windows 承载在 P07.2 实现。每帧 u32 little-endian 长度 + UTF-8 JSON，1–524288 字节；正常 EOF 不等于部分头/主体。连接建立后首帧为 Hello，成功响应 id=0 的 welcome，然后发送带 u32 id 的 RequestEnvelope。请求串行、响应回显 id；角色不能由客户端声明。

固定 schema：[v1.schema.json](v1.schema.json)，三个入口 hello/request/response。生成：

```powershell
. ./scripts/Enter-Toolchain.ps1
cargo run --quiet --locked -p session-protocol --example schema | Set-Content -Encoding UTF8 contracts/ipc/v1.schema.json
cargo test -p session-core -p session-protocol --locked
```

Hello 包含 protocol_version=1、1–64 UTF-8 字节的非控制字符 client_name、64 位十六进制 token。运行时验证与 serde 拒绝未知字段共同实施边界；schema 不代替票据/代次/状态检查。bootstrap 不进入 argv/env/renderer；帧正文与 token 禁止记录到诊断日志。

当前 Request：ping/list/read、桌面签发/撤销观察票据、显式测试 fixture 的 create/append/reconnect/close/remove、桌面 shutdown。fixture API 默认不可用，不打开设备；真实设备操作在后续步骤通过统一服务/调度接入。没有“默认当前 UI 标签”目标。

read 的 connection 必须明确 connection_id/generation；cursor 为下一事件序号、起点 1，max_bytes 4096–65536。响应 OutputPage 包含该连接代次、原始 bytes 事件、next_cursor、available_from、truncated 和 disconnected。覆盖导致缺口时客户端必须显示并重新建立解码状态，不能悄悄将截断控制序列接在一起。新代次重置事件序号，旧游标不能跨代次复用。

观察票据限 30 分钟、绑定精确连接代次，撤销/到期必须逐请求重新校验；P14 再加入生产 Agent 写权限。当前契约是本地开发 v1，不表示 P15 MCP 工具或所有设备能力已经完成。
