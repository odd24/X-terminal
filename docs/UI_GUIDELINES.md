# 界面与交互规范

这份维护手册以 Windows x64 0.1.39 便携版为基线。用户操作见[便携版使用说明](WINDOWS_PORTABLE.md)，执行、授权和提交约定见[仓库规则](../AGENTS.md)。[CR-004](changes/CR-004.md)约定 Mac 风格的清晰层级、克制材质和内容优先，[CR-022](changes/CR-022.md)保留用户原偏好和四个常用场景。阶段记录中的界面与验收按其版本阅读。

## 现行桌面交互基线

右侧快捷指令新增及编辑表单支持可选多行描述，批量脚本导入可逐项填写。紧凑列表保留一行名称。悬停、键盘预览和全部展开时，描述位于命令正文或脚本路径之前。脚本预览加载中和失败时显示描述，仍按条目、窗格和修订丢弃迟到响应。[CR-050](changes/CR-050.md) · [说明字段](../apps/desktop/src/local-adb.tsx)

右栏快捷指令表单使用「编辑快捷指令」或「新增快捷指令」作标题，原收起位置显示「← 返回」。顶部返回与底部取消共用未保存确认。取消或成功保存后回到仍打开的列表，恢复滚动位置和原条目的管理焦点。新增成功定位新条目，保存失败保留草稿。[CR-051](changes/CR-051.md)

### 布局与操作

- **窗口与工具栏。** 主窗口和独立窗口的工具栏各占一行，所属窗格的标签另起一行并紧贴终端。主窗口左上是连接库开关，右侧依次为「日志」、日志目录和「更多工具」。窄窗的工具菜单可滚动，方向键移动，Home/End 到首尾，Esc 关闭并返回触发点。保持已定稿的工具栏布局，用户明确要求时才调整。连接库紧凑，状态栏一行，详情按需展开。终端视口使用 xterm 自身滚动条，分屏拖柄与活动焦点仍可见。[窗口控件](../apps/desktop/src/window-chrome.tsx) · [窗口装配](../apps/desktop/src/main.tsx) · [CR-022 实窗证据](records/CR-022.md) · [工具栏定稿](records/P25.md#windows-x64-0110-精简顶部工具栏2026-11-21)
- **两处新建入口。** 连接库标题旁的「＋」在所选目录或根新建保存的 SSH/串口配置。SSH 的「仅保存」返回并选中原配置，「保存并连接」进入受管登录。窗格标签尾部的「＋」点击直接开 PowerShell，悬停约 350 毫秒或按向下键显示本地、SSH、串口入口。右侧快捷指令栏也有自己的添加按钮，作用域为该栏配置。[会话树](../apps/desktop/src/session-tree.tsx) · [标签](../apps/desktop/src/session-tabs.tsx) · [新建入口测试](../scripts/Test-Desktop-NewEntries.mjs)
- **删除会话配置。** 会话树右键仅打开紧凑确认，显示原名称、端点和配置编号。默认焦点在「取消删除」，取消后回到原条目，删除后回到邻项或根目录。在连接配置窗口内操作时，返回管理界面。应答不明提供对原编号的只读核对。现有连接、日志及共享凭据保留。[CR-052](changes/CR-052.md) · [确认组件](../apps/desktop/src/profile-deletion.tsx) · [桌面专项](../scripts/Test-Desktop-TreeActions.mjs)
- **聚焦和通知。** 图标有可访问名称和提示。工具弹层贴近触发按钮。应用模态弹窗可拖动标题，背景点击及从内容内拖到外面释放时保留正在编辑的内容，使用明确按钮或 Esc 退出并按原上下文恢复焦点。程序退出有独立确认。右下角使用同款通知，约五秒收起，悬停或聚焦时暂停。操作按钮立即收起原卡片，失败另报。[共享控件](../apps/desktop/src/ui.tsx) · [通知](../apps/desktop/src/corner-notice.tsx) · [通知验证](records/P25.md#windows-x64-0112-右下角通知2026-11-21)
- **右键范围。** 主窗口、独立窗口和应用弹窗屏蔽 WebView 的网页命令。可编辑文本框显示适用的文本编辑动作。会话树、标签和终端使用现有业务菜单。右键快捷指令或侧栏空白无动作，管理通过可见「⋯」。[CR-053](changes/CR-053.md) · [WebView2 过滤](../apps/desktop/src-tauri/src/context_menu.rs) · [Windows 专项](../scripts/Test-Desktop-ContextMenuPolicy.mjs)

### 标签、分屏与复制

远程复制在窗口内固定原服务、连接代次和目标窗格。只有原复制对话框可以结算结果并恢复焦点。独立窗口仍由原生层校验和移交。[复制协调](../apps/desktop/src/session-copy.ts) · [验收](records/P26.39.md)

| 行为 | 维护约定 |
|---|---|
| 方案 A | 单窗标签带 42 px，含 34 px 标签及顶部留白。分屏的操作行 26 px，与标签下沿对齐。未选标签在主题底色上以 1×14 px 短线分隔，间隔 2 px。选中仅上角 8 px 圆角，下沿直角且与实际终端背景无缝相接。标题和关闭叉按终端背景保持对比，关闭命中宽度 26 px。保留录制和拖动信号。[方案与度量](records/P26.16.md) |
| 身份、关闭与焦点 | SSH 显示真实地址，串口显示端口，正文省略短编号。同名使用提示和详情区分。标签的关闭按钮直接作用于其原身份。关闭后台标签维持原活动焦点；收起窗格会保留连接。已有双窗格工作区按记录恢复，三、四窗格布局用于当前窗口。F6 在窗格之间切换焦点。[标签关闭](../apps/desktop/src/session-tab-closures.ts) · [窗格布局](../apps/desktop/src/pane-layout.ts) |
| 拖动 | SSH、串口、本地走相同的拖放区域：标签栏重排或移入，正文中央并组，外围按预览方向分屏。拖出独立窗口和移回使用原完整身份。取消、中断与跨过拖动阈值清除双击序列，即使 WebView 随后发出 dblclick 事件，拖动新增会话数也必须为零。[手势](../apps/desktop/src/tab-drag.ts) · [拖放](../apps/desktop/src/session-drag.tsx) · [窗格模型](../apps/desktop/src/pane-layout.ts) · [原生移交](../apps/desktop/src-tauri/src/session_windows.rs) |
| 复制 | 实体鼠标双击普通 PowerShell 恰好新建一份并沿用启动目录，空闲轻量命令行沿用跟踪的当前目录。忙碌轻量、独立 ADB 结果和脚本标签双击只选中。普通标签也可右键复制。已连接的 SSH2/串口通过标签右键明确复制为独立连接。保存的 SSH 走原配置与正常身份核对，临时 SSH 补录凭据，串口预填参数并选择其他设备。独立窗口提供开副本到主窗口的入口。[本地手势](records/P26.20.md) · [连接复制测试](../scripts/Test-Desktop-SessionCopy.mjs) |

### 快捷键、剪贴板与快捷指令

- Ctrl+Tab / Ctrl+Shift+Tab 在当前窗格循环，Alt+1 至 Alt+9、Alt+0 直达前十项，Ctrl+Shift+T 开本地 PowerShell，Ctrl+Shift+B 开合快捷指令栏，Ctrl+Shift+F 查找终端。编辑器、打开的模态、菜单和 IME 组合态保持原键盘路由。Ctrl+C 在终端的选择复制和中断语义、Ctrl+Shift+C/V 及右键用真实选区与实际字节验证。[快捷键](../apps/desktop/src/desktop-shortcuts.ts) · [远端终端控件](../apps/desktop/src/terminal-pane.tsx)
- 本地右键默认有选区复制，无选区粘贴，可改为显示复制与粘贴菜单。远端的共享右键菜单保留目标窗格及日志动作。带换行或可能执行命令的粘贴先预览。空闲轻量终端是单行编辑器，前台进程中可经保护流程处理多行。剪贴板读取、预览和入队都绑定打开时的来源、原焦点和完整目标，路由变化撤确认。[剪贴板](../apps/desktop/src/terminal-clipboard.ts) · [输入队列](../apps/desktop/src/input-queue.ts) · [日志菜单](../apps/desktop/src/terminal-log-menu.tsx)
- 右侧快捷指令栏支持单/双列、当前窗格总览和管理。紧凑列表悬停或键盘聚焦后显示受控预览，脚本只读已登记引用的前 32 KiB，Esc 收起。编辑/排序/置顶/分区首尾/删除仅管理配置，移除脚本入口保留源文件。执行需显式点击行或键盘启动。目标和执行身份在点击时确定。发送模板走活动 SSH/串口的原输入及保护流程。多步本地命令回显保存原文，末步裸 ADB Shell 可以交互，失败和中断停止剩余步骤。[预览](../apps/desktop/src/shortcut-preview.tsx) · [排序](../apps/desktop/src/local-shortcut-order.ts) · [本地运行和发送](records/P26.21.md) · [脚本管理](records/P26.22.md) · [ADB 结果](records/P26.24.md) · [逐步回显](records/P26.25.md)

### 日志、异步状态与权限

| 场景 | 维护约定及位置 |
|---|---|
| 录制及目录 | 开始/停止绑定标签的完整代次，操作后台标签保留原焦点。设置页使用 Windows 原生目录选择、可写性验证、保存和恢复默认。目录限可访问的本地磁盘，拒绝网络路径、重解析路径和应用内部存储目录。默认解析至当前数据根的 `logs`，已有录制仍写开始时的目录和句柄，新录制用新设置。保存应答丢失读回提交值。目录不可用时显示失败并保留可信状态。[设置](../apps/desktop/src/log-directory-settings.tsx) · [原生目录](../apps/desktop/src-tauri/src/log_directory.rs) · [目录专项](records/P26.23.md) |
| 当前目录与原文件 | 工具栏及通知的目录动作打开当前设置。停录完成同步后释放文件，通知的文件动作按该次连接、协议、录制编号和原句柄身份打开。移走原文件或用同名文件替换时拒绝打开。历史内部记录、审计、手动另存和 MCP 保护导出拥有各自存储与授权。[录制通知](../apps/desktop/src/recording-notice.tsx) · [原生文件](../apps/desktop/src-tauri/src/terminal_logs.rs) · [另存与恢复](records/P11.4.md) |
| 操作生命周期 | 显示加载、进行中、确定失败和结果未知。冻结目标的完整身份、代次、revision 和原编号。未知只查询原编号或读取已提交值。切换、关闭、重连和迟到回应不能让输入/保存改投，重开不恢复确认。配置锁暴露原状态，只有明确复查可重试原 Locked 实例。测试覆盖成功、重复、取消、丢应答和目标变化。[连接配置与锁](records/P12.1.md) · [保存与关闭诊断](records/P24.md) |
| MCP | 0.1.39 配套 v14 仍有 33 项工具。v2 扩展查看和管理、v3 描述查看和管理分别批准。快捷指令管理不触发执行或发送，不读取脚本正文。会话动作仍需精确代次和独立能力，桥身份、批准与租约独立于桌面焦点。读取和等待按授权水位，保护导出走固定的受管位置。设置可读日志目录不授 MCP 文件访问。[桥的界面](../apps/desktop/src/shortcut-bridge-panel.tsx) · [契约说明](CODEX_INTEGRATION.md#v14-右栏快捷指令) · [日志变更的 MCP 验证](records/P26.23.md#ai-接口同步) |

## 全局样式与字体

| 所属层 | 改动入口 |
|---|---|
| 排版、主题及控件状态 | [tokens.css](../apps/desktop/src/tokens.css)统一语义变量。控件用 `--font-ui`，终端用 `--font-terminal`，含中文回退。正文 14 px、辅助 12 px、标题 18 px，控件圆角 8 px，焦点宽度及偏移均 2 px。按语义使用背景、文字、轮廓、禁用、间距及浮层变量。 |
| 布局和共同控件 | [style.css](../apps/desktop/src/style.css)及 [ui.tsx](../apps/desktop/src/ui.tsx)中的 Panel、Field、Dialog 和共享菜单。页面差异优先通过现有控件和变量表达，确需新增共用语义时同步更新对应样式和此表。 |
| 终端的字体、主题、IME | [appearance.ts](../apps/desktop/src/appearance.ts)读取 CSS，字号通过[共享字号入口](../apps/desktop/src/terminal-font-size.tsx)即时应用并自动保存，亮度 40%–100% 按设置流程保存。深色纯黑范围限于终端正文和 xterm 视口。普通文字常规字重，保留 ANSI 粗体差异。X 配色维持原 XCS 颜色，深浅主题均检查选中标签的对比和接缝、缩放和中文预编辑位置/文字/底色/轮廓。[外观变更证据](records/CR-022.md) |

## 可用性与执行证据

在实际候选构建上按影响选用下表。直接调用表中的 Node 专项时，用 `node <脚本路径> <候选 Desktop.exe>`，额外参数按表内场景填写。需要回环 SSH 的脚本先运行 `cargo build -p session-service --example gui_ssh_fixture --locked --target-dir target`。使用自建数据根、脚本拥有的 WebView 与窗口、回环 SSH、内存串口或模拟 ADB。需要物理输入时记录宿主窗口与输入方式。用测试服务之后，在 finally 核对普通服务恢复并确认拒绝测试入口。实机和长稳结论按各自记录，R15/R16 与 T22/T23 的完整矩阵见[测试计划](TEST_PLAN.md)。

| 改动 | 最小回归与可复建参考 |
|---|---|
| 标签、关闭、拖动、双击 | 同一候选构建运行 [LocalTabs](../scripts/Test-Desktop-LocalTabs.mjs) 与受影响的 [PaneGroups](../scripts/Test-Desktop-PaneGroups.mjs) / [SessionCopy](../scripts/Test-Desktop-SessionCopy.mjs)。同时断言普通本地实体双击只建一个，拖动和尾随双击建零个，忙碌、ADB 及脚本结果保持原会话。检查目录继承、同名精确身份和关闭后的焦点。[P26.20 发布门](records/P26.20.md) |
| 本地文件拖入 | [FileDrop](../scripts/Test-Desktop-FileDrop.mjs) 对候选校验正文落点高亮、当前光标引用和目录、多项、非焦点、取消及前台输入隔离。附加参数依次是候选 exe、报告路径，可选 `--event-fixture` 仅验证 Tauri 事件后的路径。 |
| 串口配置端口 | [SerialConfig](../scripts/Test-Desktop-SerialConfig.mjs) 使用与内存串口测试服务同目录的 Desktop.exe 和报告路径。校验端口下拉、刷新、设备替换、已保存的离线项、草稿及原快速连接。测试服务使用完毕后复核普通服务。 |
| 保存 SSH2 配置与登录 | [SavedSshSetup](../scripts/Test-Desktop-SavedSshSetup.mjs) 使用普通候选 Desktop.exe 与报告路径。覆盖保存后会话树选择、首次与变化的真实指纹、默认停止、密码回补及关闭后的原请求清理。 |
| 样式、主题、焦点与尺寸 | `node scripts/Test-Desktop-TabSeparation.mjs <Desktop.exe>` 重建方案 A 浅色、白底终端、关闭焦点、深色录制、宽窄分屏与同地址对照。旧候选用 `--baseline`。另按影响使用 `npm run test:desktop:appearance`、[StandardWorkspaceDpi](../scripts/Test-Desktop-StandardWorkspaceDpi.mjs)。A 版 150% 为 CDP 模拟，宿主 100%。真实 DPI 和实际中文输入另记环境。[P26.16 对照](records/P26.16.md) |
| 工具栏、弹窗、键盘、两个「＋」 | [Menus](../scripts/Test-Desktop-Menus.mjs)、[NewEntries](../scripts/Test-Desktop-NewEntries.mjs)、[Shortcuts](../scripts/Test-Desktop-Shortcuts.mjs) 按受影响场景选择，加 `npm run test:desktop:dialog-drag` 验证背景、取消与草稿保留。覆盖主/独立窗口、窄屏、无鼠标进入和返回触发点。 |
| 粘贴、控制台和快捷指令 | [LocalClipboard](../scripts/Test-Desktop-LocalClipboard.mjs)、`npm run test:desktop:clipboard`。右栏用 [ShortcutPreview](../scripts/Test-Desktop-ShortcutPreview.mjs)、[ShortcutEditor](../scripts/Test-Desktop-ShortcutEditor.mjs)、[ShortcutManagement](../scripts/Test-Desktop-ShortcutManagement.mjs) 或 [ShortcutRoutes](../scripts/Test-Desktop-ShortcutRoutes.mjs)。检查编辑返回、焦点、查看和编辑零执行、失效确认、精确字节和原命令行。 |
| 日志及异步状态 | `npm run test:desktop:log-location -- <Desktop.exe> <LogViewerProbe.exe> <报告路径>`、`npm run test:desktop:log-menu`、`npm run test:desktop:config-recheck` 及按影响的日志另存专项。探针从 [LogViewerProbe.rs](../scripts/lib/LogViewerProbe.rs) 用 `rustc` 编译。核对双录制目录、替换/移走拒绝、失败读回、丢应答命中、重启和目标变化。[P26.23](records/P26.23.md) · [P11.4](records/P11.4.md) |
| MCP | 使用 [真实 stdio 快捷指令专项](../scripts/Test-Desktop-McpShortcuts.mjs)或目录专项的 `--mcp` 路径。按影响核对清单、旧客户端、扩展授权、撤销、精确字节和保护边界。工具发现、显式客户端执行及模型回合分别报告。[P26.26](records/P26.26.md) · [部署验证](records/P26.27.md) |

## 设计参考

视觉有明确变更要求时，在同主题、同终端配色、同缩放、同窗口宽度与交互状态下捕获候选前后对照。沿对应 CR 或用户决定记录批准差异及影响区域，更新共享样式、相关断言、这份手册和步骤证据。证据标记构建版本、场景及环境，包含实际焦点、路由和结果断言。若图像只在忽略目录中，提供跟踪的复建脚本、参数和步骤记录。

<a id="cr-022-桌面常用流程"></a>
<a id="2026-11-07-全局-apple-mac-设计方向"></a>
<a id="用户常用界面参考d041"></a>
<a id="p12共享实现入口2026-11-05"></a>

早期常用流程与用户界面参考见 [CR-022](changes/CR-022.md)、[D04.1](records/D04.1.md) 及 [P12](records/P12.md)。详细历史快照可用 `git show 845cb16:docs/UI_GUIDELINES.md` 查阅。
