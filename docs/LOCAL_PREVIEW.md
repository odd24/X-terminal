# 共享终端 0.1.0 本机开发预览

这是供当前Windows电脑直接试用的开发预览，尚非正式安装包或完整v1。需要Windows及WebView2；干净系统安装、升级与签名未验。

## 启动

保留同目录的三个文件：`shared-terminal-desktop.exe`、`session-service.exe`、`terminal-mcp.exe`。双击第一个。默认使用应用用户数据目录；隔离试用可以运行：

```powershell
.\shared-terminal-desktop.exe --data-dir 'C:\Users\你的用户名\Documents\共享终端试用'
```

使用新的自建目录，不手工覆盖旧配置。关闭主窗口会停止本窗口连接和服务。此预览不自动重连或重放命令。

## 基本使用

保存SSH2或串口配置，核对真实目标后连接。SSH主机指纹和认证由桌面确认，密码不交给Codex；串口先核对端口及初始DTR/RTS。支持终端输入、显示偏好、日志及导出。设备操作使用实际目标参数，勿套用测试端口。

## Codex共享当前会话

1. 在“Agent 授权”中选定已连接目标的精确代次，预览并明确批准Read；确需输入时另勾Write和合适期限。批准本身不发送。
2. 展开“MCP 初版连接”，刷新并复制本次公开启动参数。实例及Desktop PID每次启动都不同，不能沿用上次值。
3. 在支持stdio的Codex中使用显示的command/args启动此MCP。先看工具发现，再回桌面刷新，核对实际桥进程PID及原授权编号，预览完整范围并明确勾选确认。token始终留在原生端。
4. 先让Codex只读检查。发送需独立取得输入lease（最长60秒），明确connection_id/generation/request_id和精确正文；不会自动补换行。应答不明只查原编号，不换编号重发。人工输入可接管，撤销不会撤回已执行动作。

临时CLI只读检查可用`codex exec --ignore-user-config --ephemeral --sandbox read-only -c 'mcp_servers.windows_terminal.command="实际路径"' -c 'mcp_servers.windows_terminal.args=["--stdio","--broker","本次instance","--desktop-pid","本次PID"]' '仅检查指定连接，不取租约或发送'`。路径中的Windows反斜线须按TOML/命令行规则正确转义；优先使用界面显示的实际参数。此命令不改全局配置；需要保留现有其他工具时先核对自己的配置，勿覆盖。Codex登录/模型服务需另可用。

本机Codex 0.163.0-alpha.10.2的`exec`模型已经识别实际配对和同会话，但取写入lease被客户端以“requires approval, but approval policy is never”拒绝，实际未发送。桌面授权不能代替Codex自身批准；模型写入需要客户端正常可见的交互批准流程，当前未验通过，勿用降低工具真实属性或绕过审批的参数解决。独立显式app-server客户端的共享发送/回执/读取已通过；这不代表模型自主写入或Codex桌面GUI通过。

当前9工具：agent_status、sessions_list、terminal_read、terminal_screen、terminal_send、terminal_input_status、input_lease、input_acquire、input_release。输出先Info再固定through_cursor分页；受保护票据不能绕过保护。配对快照不等于当前权限，服务持续核对到期、撤销和代次。一次只连接一个桥；应用重启后重新启动/配对。

## 限制与反馈

SSH1正式桥、复杂工作区/分屏、广播/触发器、完整MCP工具、真实设备/程序兼容、全局DPI/输入法、长期压力及安装升级仍待后续。合成SSH与内存串口专项不代表真实设备通过。极限历史重排有已知差异；缺口和未完整日志不能当完整输出。

发现问题请记录版本、协议、连接代次、时间、操作和脱敏错误，不提供密码、私钥或真实设备正文。删除本预览目录不会删除默认用户数据；退出后妥善保留自己的数据，不手工降级配置schema。
