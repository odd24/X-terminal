# 共享终端 0.1.1 · Windows x64 便携版

1. 将 ZIP 完整解压到固定目录。三个 EXE 需放在同一目录中。
2. 先在旧预览中正常退出桌面，再双击 `shared-terminal-desktop.exe`。应用需要 Microsoft Edge WebView2 运行时。
3. 默认继续使用 `%LOCALAPPDATA%\local.shared-terminal.desktop`，原来的连接配置和偏好会从这个目录读取。旧预览如果通过 `--data-dir` 指定了自定义路径，请用同一个参数启动正式版。便携包只包含程序及说明，用户数据保存在原数据目录。

同一数据目录只能由一个运行中的服务持有。若提示配置目录被占用，请确认旧预览或另一个实例已经正常退出，然后重启正式版。界面的「重新检查配置目录」也能恢复配置读取。遇到持久审计不可用时，使用 Codex 授权前需要重启。保存的会话可重新连接，正在运行的会话需先在旧窗口中妥善结束。

如需与旧预览同时试用，给正式版指定一个独立的绝对路径。

```powershell
.\shared-terminal-desktop.exe --data-dir 'C:\共享终端试用'
```

使用「更多工具 → 退出桌面」结束应用及其会话服务。接入 Codex 时，在 Desktop 的「MCP 初版连接」读取本次桥接启动参数并核对进程和授权。MCP 桥位于应用同目录。正式版包含 SSH2 和串口功能。

此便携版未作 Authenticode 签名。`manifest.json` 列出文件版本、大小和 SHA-256，ZIP 的 SHA-256 位于同目录的 `.zip.sha256` 文件。
