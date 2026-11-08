# Windows 终端模拟器

面向 SSH/串口调试、延续 Xshell 使用习惯、支持 Codex 通过 MCP 协作的 Windows 桌面终端。

初版主要需求已固定：**SSH连接服务器工作、串口/UART通信或抓取设备输出（如Android UART log）、两者基本通信日志**。先SSH再串口，日志随各连接流程交付，简单开始/停止并查看保存位置；界面围绕连接、终端、日志，其他能力后续。见[主要需求](docs/REQUIREMENTS.md#初版主要需求2026-11-08用户明确)和[执行方案](docs/EXECUTION_PLAN.md#现行路线cr-006)。

2026-11-08 P12.1已实现“连接服务器 → 弹窗填写信息 → 同流程指纹/认证确认 → 关闭弹窗进入终端”，无需先建配置；保存可选，高级功能按需收起。连接配置/外观共享弹窗，会话导航保留；SSH标签只显示服务器地址，失败在弹窗内明显说明已知原因和下一步。SSH日志从顶部开始/停止，停止后可查看并通过系统窗口保存可读UTF-8文本`.log`。用户已报告SSH实际成功，既有保存凭据的独立真实登录也已验证；实际构建/新弹窗软件专项和准确边界见[P12.1](docs/records/P12.1.md)。本次新界面待用户试用反馈，S2新串口流程尚未展开。

## 本机开发预览与使用资料

本机初版已准备：[试用说明](docs/LOCAL_PREVIEW.md)。构建后`npm run preview:local`生成三个相邻二进制/说明/指纹，并实际检查复制品普通启动与关闭。基本stdio桥提供9工具，原生端持独立Agent身份；真实Codex app-server显式客户端已在桌面原SSH连接完成一次发送/原回执/读取。实际模型已识别同会话，但写lease被Codex自身approval never拒绝且未发送；正常交互批准/模型写入尚未验通过，详见[P16](docs/records/P16.md)。这是本机开发预览，完整v1及正式安装仍后续。

“Agent 授权”可按精确连接代次预览并批准独立范围/期限，查询原编号、当前有效范围、输入租约，显式撤销或人工接管；可明确选择时间窗、单次/任务形式和服务端输出保护。独立持久审计提供同步/失败状态与固定水位只读历史页，保留窗口/坏尾明确显示。窗口只恢复service_id/request_id，不恢复同意或token；原生回复不向WebView暴露token。签发后仍须从“MCP 初版连接”核对本次进程/原授权并单独配对；桌面批准不能代替Codex自身批准。详情见[使用说明](docs/ALPHA_USER_GUIDE.md)与[P14](docs/records/P14.md)。

在授权目标类型中选择“已保存配置建连”，可独立批准SSH2/串口的固定Profile与配置版本；预览完整参数及串口初始DTR/RTS，批准前重新核对版本，变更后须重新预览。只授Connect且不立即建连，不授新连接的其他能力或认证批准。

底部状态栏跟随活动连接，显示编码、本地终端列×行、日志及桌面输入状态；“连接与服务详情”可展开完整连接ID/代次和服务身份。配置名称由实际连接的配置ID关联，刷新会话树后反映配置改名；删除配置不会关闭既有连接，名称回退协议/短ID。视口尺寸不代表远端PTY已经应用，串口没有远端PTY；“桌面输入可用”也不代表设备执行成功或Agent已授权。日志面板关闭后记录继续，底部仍显示本次服务状态，查看/停止记录可重新打开“终端日志”。

当前状态：**桌面开发预览**。SSH2 与串口已接入统一会话服务/桌面并有隔离软件验证；配置/保护凭据、输入/任务去重、串口编码接收与服务派生文本/屏幕已实现。日志历史/导出/恢复、基础导航/标签/撰写、显示偏好，以及Agent软件授权/调度/输出保护/审计的证据分别见步骤记录；SSH1、真实 MCP/Codex闭环、完整桌面体验及后续效率功能仍在执行，真实设备与发布验收尚未完成。各项证据见[执行台账](docs/EXECUTION_LOG.md)。基础操作见[桌面开发预览使用说明](docs/ALPHA_USER_GUIDE.md)。

## 执行入口

1. 阅读 [AGENTS.md](AGENTS.md)：协作约束与每步 Git 提交规则。
2. 阅读 [需求基线](docs/REQUIREMENTS.md) 和 [架构方案](docs/ARCHITECTURE.md)。
3. 按 [执行计划](docs/EXECUTION_PLAN.md) 的依赖和阶段门推进。
4. 在 [执行台账](docs/EXECUTION_LOG.md) 更新状态并创建步骤记录。
5. 需求/架构发生变化时按 [变更管理](docs/CHANGE_CONTROL.md) 操作。

配套文档：[Codex 接入](docs/CODEX_INTEGRATION.md) · [验收计划](docs/TEST_PLAN.md) · [变更日志](CHANGELOG.md)。

## 已确认与暂定

- 已确认：Windows、SSH1/SSH2、SERIAL、会话管理、标签组、同步输入、快速命令、撰写窗格、触发器、首版外部 Agent 为 Codex。
- 暂定：Windows 10/11 x64；Tauri 2、React、xterm.js、Rust、SQLite；本地 stdio MCP 桥接。
- 未确认：实际 SSH1 设备、串口参数、旧 UNIX 版本、认证环境、最低系统版本、正式产品名。
- v1.0 必须包含用户提出的功能；内置 AI 聊天、SFTP、X11、云同步为后续候选，不代替首版 Codex 接入。

所有执行步骤均需本地 Git 提交；不自动推送、发布或修改用户全局 Codex 配置。

## 本地开发

Node 24.14.0 / npm 11.9.0；Rust 1.99.1 MSVC（rust-toolchain.toml）；MSVC 与 Windows SDK、WebView2 是系统前置条件。版本和本机调查见 [ADR-001](docs/decisions/ADR-001.md) 与 [环境清单](docs/evidence/P01-environment.md)。

```powershell
. ./scripts/Enter-Toolchain.ps1
npm ci --ignore-scripts
npm run lint
npm run build
npm test
npm run test:screen
cargo test -p transport-ssh2 --locked
cargo test -p transport-serial --locked
cargo build -p mcp-bridge --locked
npm run test:mcp
npm run test:codex-mcp
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run desktop
# 生成本地调试版桌面可执行文件，不打安装包
npm run desktop:build
npm run test:desktop
```

仓库本地 Rust 存放在被忽略的 .tools 目录，其他开发机可以使用已安装的 rustup；Enter-Toolchain 仅在本地工具存在时切换。安装依赖后可用 `node scripts/Dependency-Licenses.mjs --cargo` 更新依赖许可元数据。产品代码许可尚未确定，当前 workspace 标为 LicenseRef-Proprietary；不暗示获得第三方分发权。安装发布留待 P25。

P03 的 SSH2 测试服务器只在回环地址启动，key/测试口令在内存生成；这证明协议子项，不代表 Linux/UNIX/真实设备验收。具体缺口见 [P03 矩阵](docs/evidence/P03-ssh2-matrix.md)。

P05 可用 `cargo run -p transport-serial --example enumerate` 只读列举端口；不自动打开设备。真实字节收发与控制线行为待指定设备验证，见 [P05](docs/records/P05.md)。

P06 已有只读 mock MCP 原型与真实 Codex CLI app-server 客户端互通测试，使用隔离配置、无模型推理，不修改全局设置。它不访问实际会话，见 [P06](docs/records/P06.md)。

P07 已增加协议中立状态机、有界原始输出、内存只读票据与 [IPC v1](contracts/ipc/README.md)，以及受限 Windows Named Pipe 服务。可运行 `cargo test -p session-core -p session-protocol -p session-service --locked`；桌面启动、原生 ACL/跨进程、页面暂停/重载、退出/崩溃已验证，这些合成结果不代表实际设备验收通过。

P08.1 已有独立 SQLite 配置存储与真实临时数据库测试：`cargo test -p config-store --locked`。配置迁移/备份/新目标恢复、Profile/目录 CRUD 可在库层使用，配置服务与编辑器已在 P08.3 接入，见 [ADR-008](docs/decisions/ADR-008.md)。

P08.2 已有 Windows 用户级 DPAPI/AES-GCM 凭据库：`cargo test -p credential-vault --locked`，只用合成秘密验证真实保护 API、跨进程重开与篡改拒绝。配置服务与桌面凭据流程见 P08.3，见 [ADR-009](docs/decisions/ADR-009.md)。

`npm run desktop:build` 同时构建相邻的 session-service.exe。直接运行 `target/debug/shared-terminal-desktop.exe` 默认不启用合成接口；追加 `--test-fixture` 可手动新建合成会话。键盘合成回显和高输出均通过同一服务，页面重载从保留游标重新呈现；输出覆盖会明确报缺口。退出桌面会停止服务，当前没有退出后的后台驻留；隐藏标签可保留窗口内连接，退出仍停止服务。服务不可用时不自动重连/重放，退出后重新启动会得到全新服务；不能把重载当作重连。启动失败请检查相邻服务文件与普通用户权限，当前不提供安装包。

P08.3 已有 Desktop 专用配置 IPC 后端、有界工作线程和明确配置故障；桌面已传入独立数据目录并提供编辑器。完整产物及边界见 [P08.3](docs/records/P08.3.md)。

P08.3 桌面增量已接入“连接配置”：目录与 SSH2/SSH1/SERIAL Profile 编辑、复制/移动/删除、凭据引用管理，保存不打开设备。默认使用应用本地用户目录，可通过 --data-dir 绝对路径选择其他目录；所有自动化测试使用独立临时目录。私钥表单只输入本地普通文件路径，内容由服务读取并加密，源文件不修改，页面不接收私钥明文。主机密钥、配置导出与备份恢复、凭据整理现已接入。npm run test:desktop 同时运行生命周期和配置编辑器的真实 WebView 测试，也可单跑 npm run test:desktop:config。

P08.3 已有主机密钥信任库与 GUI 管理：显示完整指纹，移除须勾选且与当前记录匹配；变更冲突不会自动删除。存储层只读判定未知/已知/变化，批准要求当前版本，SSH1/SSH2/端口分别隔离。真实首次/变化握手确认由 P09/P13 接入，见 [ADR-011](docs/decisions/ADR-011.md)；备份恢复/凭据整理现已提供桌面入口。

P08.3 的恢复存储层已增加一致镜像/预览摘要和事务恢复，安全副本不覆盖原文件，中途 SQL 失败回滚。现已提供服务/桌面导出与恢复入口，详见 [ADR-012](docs/decisions/ADR-012.md)；原生桌面流程已验证，设备与安装恢复验收仍在后续步骤。

P08.3 现有“配置导出与备份恢复”入口：便携 JSON 排除凭据引用/信任记录，配置备份保留引用/信任记录但不含秘密或 vault。预览并勾选后可恢复，替换前保存旧库；坏库可恢复到新目录，再用 --data-dir 指定该目录启动。缺引用会提示重新输入。所有操作通过统一服务，不重连已有会话；凭据整理支持元数据列表、引用检查和显式遗忘。可单跑 npm run test:desktop:archives，细节见 ADR-012。

P08 凭据整理可运行 npm run test:desktop:credentials。只显示 UUID/引用数；检查当前配置和 artifacts 受管理备份，仍有引用或备份不可读时拒绝遗忘。界面明示外部副本不在核对范围，遗忘不承诺磁盘物理擦除。所有自动化均用随机临时目录和合成秘密，尚未连接实际设备。

P09 服务已接入 Profile/受保护凭据、主机挑战、密码/加密密钥/交互认证、共享原始输出、有界 FIFO 输入/resize、增量 exec 任务和同 ID 递增代次的显式重连。所有写入明确连接代次和 request_id；成功只表示进入 SSH 发送管线，结果未知不自动重试或重放。只有 Desktop 可控制；Agent 授权与长期容量继续实施，细节见 ADR-014–ADR-018 和 [P09 记录](docs/records/P09.md)。

桌面“SSH2 连接”面板可手动连接已保存 UTF-8/GBK/GB18030 SSH2 配置、确认完整主机指纹、提交临时密码/保存凭据/交互回答、关闭和显式重连；终端输入与尺寸经统一服务，输入诊断不显示真实按键。连接与exec均使用建立时冻结的编码；配置修改不改变旧代次，无法表示的文本整批拒绝。exec 面板支持状态、增量输出、显式缺口、取消与按任务 ID 查询；重载不重新执行。页面重载保留服务会话，不自动重连。

完成 npm run desktop:build 后，可运行 npm run test:desktop:ssh 构建隔离回环服务器并操作真实 WebView，覆盖指纹/认证/输入/尺寸/退出/重载。npm run test:desktop 包含此场景和原生命周期、配置、备份、凭据回归；所有配置和合成秘密使用临时目录。尚未连接实际 Linux/UNIX/用户设备，不代表 G0–G4 或完整产品验收通过。

串口面板支持显式设备/控制线确认、文本/HEX/换行/节奏、RTS/DTR/Break与独立有界HEX接收；文本按打开时的UTF-8/GBK/GB18030快照增量解码。真实驱动占用/拔插、控制线及参数兼容待实机验证。`npm run test:desktop:serial`仅以测试编译的内存端口操作实际WebView，结束后检查普通服务恢复，不代表COM驱动验证。

“屏幕快照”读取桌面当前视口；“服务端屏幕”读取统一服务持续维护的屏幕，GUI重载不重建服务状态。快照标出编码/尺寸/来源游标、接收缺口/解码错误和截断情况；当前解析器支持有界普通屏重排，替代屏切换已有有限合成验证；极限历史容量仍有BUG-001差异，真实程序/更广VT兼容未完整验收。原始字节、解码文本与screen分别有界保留，已可显式启停持久终端日志，历史读取/浏览/字面搜索及普通导出/另存已接入，普通与未完整恢复产物均有独立原生另存入口。详见[ADR-028](docs/decisions/ADR-028.md)。`npm run test:desktop:output`验证专用读取入口、保留覆盖与跨连接控制序列隔离；完整桌面回归包含该专项。

P11.3已实现独立有界日志引擎，可运行 cargo test -p terminal-log --locked 验证真实临时文件、轮转与故障。P11.4启停阶段已接入服务/桌面：在“终端日志”面板显式开始/停止，默认不记录；只包含启用后的终端新输出，关闭面板/重载不停止，重连不自动继承。同步/失败见日志状态；本次服务记录与持久历史分开显示，历史浏览/搜索与导出已接入，特殊目标、长期稳定性和跨重启保存恢复仍见步骤记录。格式和完整性边界见[日志格式](contracts/logging/README.md)。

日志原生专项 npm run test:desktop:logging（前置 npm run desktop:build）使用独立临时目录/合成连接，验证启停/重载/轮转/故障；完整桌面回归现包含该专项。日志源缺口/拒绝记录/退休段必须结合查看，保留窗口同步不代表完整连接或远程成功。

历史查看：打开“终端日志”→展开“历史日志与搜索”→刷新目录→选择日志→打开历史日志。历史目标与活动连接分开，重启后无连接也可读取已完成日志；下一页替换当前页，时间显示北京时间，文本控制字符可见，HEX保留原始字节。字面搜索区分大小写，完整扫描保留范围并统计匹配总数，最多显示前100条；取消/错误不声称全文完成，退休段/捕获前不在范围内。关闭日志面板会释放历史读取，终端记录仍继续。

可运行 npm run test:desktop:history（前置桌面构建），完整回归包含。普通日志导出/另存、失败前缀浏览与显式容量整理已接入，验证范围与限制见[P11.4记录](docs/records/P11.4.md)。

失败日志可在“终端日志 → 历史日志、搜索与导出 → 失败日志只读前缀恢复”中刷新并独立选择目标。关闭正在占用源文件的恢复读取后，点击“导出未完整恢复前缀”，生成应用目录内的 JSONL。任务身份固定，不随选项或活动连接切换；结果显示确切前缀计数和停止原因，即使到达文件结尾也不代表源日志完整。丢应答或重载后仅查询原任务，已有产物不会因取消而撤销。恢复导出完成后可使用独立“另存未完整恢复文件”入口打开系统选择器，已有文件仍需独立确认替换并保留备份；未完整报告持续保留。不要用普通日志另存入口处理恢复编号。可运行 npm run test:desktop:recovery（前置桌面构建）验证合成临时日志的浏览/导出与故障处理。


## 显示偏好与复制粘贴（P12开发预览）

1. 打开“外观”，选择深色、浅色或跟随系统，独立终端配色（跟随应用、黑底绿字、黑底白字）以及Consolas/Cascadia优先的终端字体；字号在工具栏调整，中文使用系统回退字体，无需安装字体。调整立即应用于本窗口。
2. 可设置Ctrl+C有选区时复制、Ctrl+V粘贴、右键粘贴。无选区Ctrl+C仍发送终端中断；关闭选区复制后Ctrl+C交给终端。Ctrl+Shift+C/V和复制/粘贴按钮始终可用。关闭Ctrl+V时它是终端控制键，关闭右键粘贴则保留系统菜单。
3. 点击“保存桌面偏好”后，当前数据目录的窗口重载或下次启动会读取这些设置；仅调整、不保存则重载丢弃。切换启动数据目录使用该目录自己的偏好。“重新读取偏好”会丢弃本窗口未保存的调整。
4. 保存报错或结果不明时，先重新读取核对当前值；程序不会自动重试保存。设置改动会取消待确认粘贴；多行/控制字符粘贴仍须核对精确目标与预览，不能由习惯开关跳过确认。
5. 配置备份包含显示/习惯偏好，恢复前预览明确展示，恢复后主窗口重新应用；便携连接JSON不带这些偏好。草稿、剪贴板内容、终端正文和发送同意不保存，工作区/标签布局持久化继续P17。

当前仍为开发预览，基础用户说明见[使用说明](docs/ALPHA_USER_GUIDE.md)，全局主题/字体/DPI/输入法及实机验收继续，不能把偏好专项当整个P12或G1完成。迁移/备份兼容与回退见[ADR-042](docs/decisions/ADR-042.md)、[配色schema 4](docs/decisions/ADR-043.md)，实际结果与失败记录见[P12](docs/records/P12.md)。
