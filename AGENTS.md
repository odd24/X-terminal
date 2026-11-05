# 仓库执行规则

适用本仓库全部目录。用户明确指令优先于本文；本文不是要求重复审批的理由。默认中文沟通、文档 UTF-8、日期 Asia/Shanghai。

## 开始工作

1. 查看 `git status --short --branch` 与近期 `git log`，保留用户已有修改。
2. 阅读 `docs/EXECUTION_LOG.md`，再阅读当前步骤在 `docs/EXECUTION_PLAN.md` 的条目、关联需求/架构/测试和已有记录。
3. 只选择前置条件满足的工作包；未完成工作从现有状态继续，禁止重建仓库或覆盖历史。
4. 本轮用户只要求方案与文件时，不自动展开整个应用开发。进入实施后按获授权范围持续完成步骤。
5. 当前已建立 P01 桌面骨架；不得将骨架构建当作产品功能或实际设备验收完成。

## 每步必须提交

- 每个有独立产物或结论的步骤/子步骤至少一个本地 Git 提交；不要将多个独立工作包攒成一个提交。
- 分支默认 `codex/<topic>`。用户未要求远程操作时，只做本地提交，不 push、不发布。
- 提交格式：`<type>(<Step-ID>): <summary>`，正文独立一行 `Step-ID: Pxx`。types：feat/fix/test/docs/chore/perf/refactor/build。
- 同一次提交包含相关实现、验证证据摘要、`docs/records/<Step-ID>.md`、台账状态及必要的文档变更。
- 先验证，再暂存明确路径，检查 `git diff --cached --check` 与 diff，再 commit；提交后检查历史与工作区。
- 不使用无差别 `git add .` 混入用户文件。不自动 amend、reset --hard、clean 或强制改写历史。
- 本步记录以 Step-ID 关联自身提交，不写尚不存在的自身 hash；历史 hash 在后续记录中回填或由查询生成。
- 若步骤未完成，记录 IN_PROGRESS/BLOCKED 和真实原因，提交有价值的阶段成果；不通过空提交制造进展。
- 提交失败时停止依赖该提交的后续步骤，记录实际原因；不声称完成。需要回退时新增 revert 提交并同步台账。

## 设计约束

- 首版外部 Agent 是 Codex，接入方向为 Codex → MCP stdio 桥接 → 会话服务；不把另起 SSH shell 当作共享当前会话。
- SSH1、SSH2、SERIAL 都是完整 v1.0 范围。SSH1 显式开启，不自动降级；不可因选库不支持而静默删除需求。
- UI、Codex、广播、触发器走统一服务和输入调度；禁止旁路访问底层连接。
- 所有自动化操作明确 connection_id/generation；写入 request_id 去重；重连不重放命令或继承过期授权。
- 用户输入可接管 Agent；取消不能承诺远程已执行动作被撤销。
- 原始字节/解码文本/屏幕/审计分开，队列有界，输出缺口显式报告；串口不编造退出码。
- 凭据进入 Windows 保护存储，仅保存引用；不提交密码、私钥、真实设备日志、全局 Codex 配置。
- 参考 Xshell 交互与授权样本，不复用其私有 DLL/资源，不尝试解密凭据。
- 技术栈为候选，P01–P06 证据决定最终版本；变更记录 ADR，不把设想当事实。

## 文档与变更

- 所有界面新增与修改遵循 [界面与交互规范](docs/UI_GUIDELINES.md)：布局与视效符合现代桌面应用习惯，操作逻辑简洁；全局样式和字体统一，通过共享设计变量及公共控件维护。终端采用统一等宽字体配置，主题、中文回退、焦点及状态样式保持一致。不得为单个页面随意增加独立配色、字体或重复样式；例外须说明用途并更新规范。验收依据 R15/R16、T22/T23，不能以界面示意或工程原型替代实际桌面验证。

- 产品范围改变：创建 CR，更新需求→计划→测试→台账→CHANGELOG，保留原编号。
- 架构/依赖选择：创建 ADR，包含候选、证据、代价、迁移/回退。
- 用户已授权的常规实现选择可直接完成并记录；影响明确需求/用户环境的缺失信息才需要澄清。
- 实机缺失时只阻塞相关验证，继续独立工作；mock 通过不能替代实机通过。
- 不主动创建子 Agent；仅用户或适用指令明确要求并行 Agent 工作时使用。

## 当前可用检查

```powershell
pwsh -NoProfile -File scripts/Validate-Docs.ps1
git diff --check
git status --short --branch
```

准备提交一个新完成步骤时，用 `-PendingStep <ID>` 仅豁免该步骤“已经有历史提交”的检查，提交后必须无参数复查。

```powershell
pwsh -NoProfile -File scripts/Validate-Docs.ps1 -PendingStep P01
git diff --cached --check
git log --all --format=fuller --grep='^Step-ID: P01$'
```

P01 建立的实际命令如下（执行结果见步骤记录，不以命令存在推断通过）：

```powershell
. ./scripts/Enter-Toolchain.ps1
npm ci --ignore-scripts
npm run lint
npm run build
npm test
npm run test:screen
cargo test -p transport-ssh2 --locked
cargo test -p transport-serial --locked
cargo test -p session-core -p session-protocol --locked
cargo test -p session-service --locked
cargo test -p config-store --locked
cargo test -p credential-vault --locked
cargo build -p mcp-bridge --locked
npm run test:mcp
npm run test:codex-mcp
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run desktop:build
npm run test:desktop
npm run test:desktop:config
npm run test:desktop:archives
npm run test:desktop:credentials
```

`npm run lint` 当前为 TypeScript 严格类型检查。P01 无业务单元用例，不以零用例测试宣称功能通过。`npm run desktop` 启动开发窗口。代码变更执行受影响的格式/静态/单元/集成检查；协议、调度、权限和迁移必须有实质测试。仅文档变更做文档检查，不为文字修改编写镜像测试。

P09/P10 新增 `npm run test:desktop:ssh` 与 `npm run test:desktop:serial`，前置为 `npm run desktop:build`。串口专项编译仅测试用的 `serial-ui-fixture` 服务，以内存串口验证实际 WebView/IPC，finally 尝试恢复普通服务二进制；必须检查恢复命令实际成功，不能把内存后端当作虚拟/真实 COM 驱动验收。完整 `npm run test:desktop` 包含这两个专项。

P11.1 新增 `npm run test:desktop:output`（前置桌面构建），以合成会话验证输出覆盖缺口与终端解析重置；完整桌面回归包含该专项。串口专项还覆盖 GBK/GB18030 增量显示/编码快照/尾字节提示，仍不代表驱动验收。

## 结束工作

报告已完成的步骤、产物、验证、提交短 hash、未解决问题与下一步；工作区应干净，若用户已有修改保留并说明。未执行的检查明确写“未执行”。

P11.2 扩展公共 IPC 的 read_text/screen 与桌面专用 service_read_text/service_screen；受限只读票据沿用作用域/到期/撤销/代次。vt100 使用 vendor/vt100 最小补丁（替换字符显示），修改解析器时运行 npm run test:screen，已知 reflow 差异不能误报通过。

P11.7增加npm run test:history，以生产512历史/尺寸上限逐步比较全部保留行/可见列/软换行及单元格属性；history_probe必须读取Screen克隆，set_scrollback可能扩展存储行。原始history-baseline与local.3的history-after分别保留，参考摘要不能改变；正常与--record均不允许增加未登记差异。local.3的63匹配/4已知差异保留；local.4独立history-local4为65匹配/2容量差异，新增Compare-Alternate（纳入test:history）9组84逐步快照须全部匹配，--record也不能新增豁免，alternate-before/after分别保留。BUG-002有限软件修复不等于全部VT兼容，BUG-001容量/真实程序仍开放；解析器修改同时运行此命令、原test:screen及受影响服务/原生回归。

P11.3 新增独立terminal-log：cargo test -p terminal-log --locked、cargo clippy -p terminal-log --all-targets --locked -- -D warnings。测试只写带前缀的中文临时目录并清理自建junction，不记录真实设备；引擎通过不能冒充P11.4服务/GUI日志已启用。

P11.4启停阶段新增 npm run test:desktop:logging，前置桌面构建，已加入完整桌面回归；只记录合成临时输出。日志RPC走独立配置通道，仍禁止通用RPC/任意路径。服务/原生验证必须区分本次列表与持久历史，以及写入/同步/源缺口，不能将启停通过当作搜索/导出或长稳完成。

P11.4历史界面新增 npm run test:desktop:history（前置桌面构建），完整回归包含。只用合成日志，验证跨记录全文计数/显示限额、独立目标、取消/关闭回收及坏尾行；控制字符/HTML只能作为文本，不写入当前终端。时间Asia/Shanghai；T22/T23全局矩阵及导出/恢复不得从专项推断通过。

P11.4清理界面新增 npm run test:desktop:cleanup（前置桌面构建），完整回归包含。只清理自建中文前缀临时目录；验证独立目标、占用拒绝、显式勾选/取消、真实租期、应答丢失后仅查询及关闭迟到释放。APPLIED不等于完整成功，核对实际删除计数/目录/失败；不可撤销已删除前缀，重载不恢复确认。

P11.4失败关联维护使用release_failed与RELEASED，仅已结束FAILED，按ConnectionRef/log_id幂等解除，未删除任何文件。capture_list提供本次最多64项跨连接/旧代次清单，独立维护不跟随活动连接；重启不重建回执。不要把它当作REMOVED、失败前缀恢复或物理容量已释放；旧Start仍去重/退休，不因回收而重放。npm run test:desktop:logging覆盖实际维护入口与丢应答后原目标查询、重连/移除后无活动连接维护；无目录失败的确定性服务组合测试与已有目录失败的IPC/GUI证据分开记录。新增合成生命周期命令只在--test-fixture下有效，普通桌面专项必须逐项拒绝，不提供通用RPC。

P11.4导出完成回执新增sha256，只有COMPLETED携带64位小写值，REMOVED及非完成为null。VerifiedExport仅Windows固定受管理UUID/文件读取，复制前后核对可信回执；copy_to只面向私有暂存sink，Err可能已写部分或全部字节，Ok不等于目标同步/发布/用户覆盖授权。新增样本仅中文前缀临时目录；原生test:desktop:export以Node crypto核对实际落盘指纹。原生保存与打开目录未接入时不得从库验证通过宣称自选位置已保存。

P11.4自选保存新增npm run test:desktop:save（前置desktop:build），纳入完整桌面回归。只以shared-terminal-save-ui-中文-临时根操作实际系统选择器/自建输出目录与Explorer窗口，不能关闭其他用户窗口。原生任务固定源scope/save_id，禁止调用者路径/角色/指纹；已有普通本地文件需独立确认，保留原文件backup，冲突可RECOVERY_REQUIRED，不承诺原子回滚。取消不能撤销已开始的发布；结果不明只查询，重载不恢复同意。网络/特殊属性兼容及跨重启恢复仍需单列证据。

P11.4受管理导出任务扩展test:desktop:logging：验证专用Tauri通道的export_start/status/cancel和真实暂存产物，不代表用户保存按钮/自选位置已完成。导出队列8/回执64，磁盘尝试8/每份256MiB；失败partial保留，不自动清理或覆盖。涉及格式/文件策略继续运行terminal-log测试及严格clippy，任务权限/去重须有真实Windows IPC证据。

P11.4桌面导出新增npm run test:desktop:export（前置桌面构建），已纳入完整回归；受管理保存路径不等同自选另存位置/打开目录。应答故障/延迟注入在测试Harness的真实IPC fetch响应处执行并核对命中数，禁止靠重写不可写的Tauri invoke制造未生效的通过证据。只用合成临时日志，保留任务精确目标和应答不明语义。

P11.4整理文件库采用ADR-031的Windows句柄预览/逐项删除，禁止递归清理未知内容；partial失败必须报告已删除的确切前缀，不能声称回滚或物理空间已释放。按terminal-log测试/严格clippy验证，测试只清理自建中文前缀临时目录及junction。库层通过不代表已开放服务/GUI确认，后续必须同步去重、到期与日志/导出注册状态。

P11.4整理服务新增cleanup_*（Desktop专用），4快照/30秒/128回执/8队列；APPLIED仍须核对report完整成功。过期测试须维持IPC心跳，不能把空闲断线当租期回收。清理影响后REMOVED与有序回执水位必须验证旧请求不重跑；原生导出专项现覆盖RPC整理后自动撤下失效路径，仍不表示已有GUI清理确认入口。

P11.4桌面恢复新增npm run test:desktop:recovery（前置desktop:build），已纳入完整桌面回归。只用shared-terminal-recovery-ui-中文-临时根，验证独立旧服务身份、缺标志/截断前缀、未完整结尾、HEX/文本、原始文件保持、真实IPC应答丢失/迟到关闭及清理后缓存撤下；不代表恢复导出/真实磁盘耗尽/长期或全局UI矩阵已通过。所有恢复读取编号与正文不持久化，重载不恢复授权或自动重开。

P11.4恢复导出扩展test:desktop:recovery的专用logging_request通道验证，以Node crypto独立核对真实JSONL的长度/SHA-256、精确两条前缀及未完整停止尾行，重复Start/晚Cancel保持，普通查询拒绝。原生构建与专项实际PASS，完整回归结果见P11.4；未接恢复导出/另存按钮时不得由通道通过宣称GUI保存完成。

P11.4恢复导出GUI扩展test:desktop:recovery，真实按钮/IPC应答丢失及迟到折叠、Page.reload编号恢复、Node crypto落盘指纹和清理后撤下路径；仍只用shared-terminal-recovery-ui-中文-自建临时根。应用目录发布不等于恢复原生另存，后者须固定来源模式并从对应服务回执获取可信指纹，不得把恢复ID走普通查询或把未完整报告改成完整。

P11.4恢复原生另存已按NORMAL/RECOVERY必填固定来源模式接入，对应服务回执取得生产指纹后才打开选择器；所有保存操作保持模式/精确scope/save_id。恢复GUI复用共享面板但独立编号槽，未完整说明持续显示，重载不恢复路径/替换同意，应答不明只查询。test:desktop:recovery使用恢复数据中文前缀根及另建shared-terminal-save-ui-中文-目标根操作真实选择器/自建Explorer窗口，核对逐字节/SHA-256/备份/丢应答/重载/迟到及清理后用户副本保持；特殊目标/跨重启/全局UI矩阵不从专项推断通过。

P11.6新增npm run test:desktop:clipboard（前置desktop:build，纳入完整回归），只用shared-terminal-clipboard-ui-中文-自建根验证真实WebView的paste事件/预览与合成服务精确CR/LF。SSH专项另以真实Ctrl+C/系统复制/原生terminal_clipboard_read/鼠标按钮核对精确回环字节与无选区0x03；读取延迟在真实IPC fetch处注入并核对命中。Windows读取仅CF_UNICODETEXT，有界单worker/3秒前端等待，超时不取消已开始的OS读取、不自动重试；正文/同意不持久化。默认当前buffer查找、默认主题截图与合成回环不代表实机vim/top/less/tmux、BUG-001 reflow或T22/T23全局矩阵通过。
