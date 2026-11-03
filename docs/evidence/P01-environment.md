# P01 本机环境调查

日期：2026-11-03（Asia/Shanghai），执行者 Codex；基线 f871e0f，初始工作区干净。

| 项目 | 实际观测 |
|---|---|
| 系统 | x64，build 22631.6199，DisplayVersion 23H2；注册表 ProductName 仍为 Windows 10 Pro，按 build 识别为 Windows 11 |
| CPU | Intel Core i3-12100，4 核/8 线程 |
| RAM | 16,908,730,368 字节，约 15.75 GiB |
| Node / npm | 24.14.0 / 11.9.0 |
| Codex CLI | 0.163.0-alpha.10.2（未改动全局配置） |
| MSVC | 14.50.35717；cl.exe 路径检查通过 |
| Visual Studio Build Tools | 18.3.11520.95（18.3.2） |
| Windows SDK | 10.0.26100.0；x64 kernel32.lib 存在 |
| WebView2 | 156.0.4314.58，注册表查询 |
| Rust 初始状态 | 不在 PATH，默认用户 .cargo 中未安装 |
| Rust 安装后 | 1.99.1 MSVC，仓库 .tools 中；含 clippy/rustfmt |

工具链探测中 vswhere 的 VC 组件过滤未返回实例，但实际 cl.exe/SDK 文件存在。尝试 VS Installer 补装返回 5007，日志说明 quiet 模式需提权；本次未提权、未成功补装。后续以实际编译证据判断已有组件是否完整。

桌面客户端具体版本、屏幕/DPI/输入法、Windows 10 和其他设备矩阵未执行调查，本记录不替代 P16/P23 验证。
