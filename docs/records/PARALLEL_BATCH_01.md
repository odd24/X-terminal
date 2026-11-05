# 第一批并行执行现场

- 日期：2026-11-05（Asia/Shanghai）；归属：D05 / CR-003 执行组织记录，不新增产品 Step-ID。
- 用户已实际发送正式执行与 A/B/C 必要接续授权；仅本地开发、验证及提交。
- 共同基线：`40572326fde123bd3917068e5e7ece5f1deb23bd`，包含最新启动文档；不是调查基线 d80f5b2。
- A 接管 HEAD 同上；集成分支 `codex/execution-plan`，接管时干净，没有用户未提交修改。

## 角色、目录及会话

| 角色 | 会话 ID（host=local） | 绝对目录 | 分支 | 当前事实 |
|---|---|---|---|---|
| A | 01a1aac7-92ed-7043-a3eb-72a03a97d8b9 | E:\Users\Administrator\Documents\ChatGPT\终端模拟器 | codex/execution-plan | 统筹；唯一集成写入者 |
| B | 01a1aacf-a67a-7ef2-90ef-d62d2a761b2b | E:\Users\Administrator\Documents\ChatGPT\终端模拟器-reflow | codex/p11-reflow-extreme | 命令核验匹配，16:29已放行开发 |
| C | 01a1aacf-f7f7-7150-af85-f5d1a78a722b | E:\Users\Administrator\Documents\ChatGPT\终端模拟器-save | codex/p11-save-boundaries | 命令核验匹配，16:29已放行开发 |

A 已用各目录的独立 shell 核对 B/C 分支及完整 HEAD 均等于共同基线、工作区干净；Git worktree 清单精确为以上三处。这些是 A 的检查，不能代替 B/C 实际接管报告。两处 target/node_modules/artifacts 按 worktree 本地路径使用，不共享可变构建目录；尚未安装依赖或构建。各自 Enter-Toolchain.ps1 无本地 .tools 时不配置工具链；不得由此推断 cargo/npm 可用。

## 任务及边界

B 执行 P11.7：满历史 2↔500 列 / 600 行往返的最小复现、活动行/裁剪/重排原因及可安全完成的修复。所有权为 vendor/vt100、session-core 的 screen/presentation 及相关测试、reflow 夹具/Compare-Screens、P11.7 证据/记录、ADR-038。保留既有原 7 项与新增 27 项严格匹配，极限 KNOWN_DIFFERENCE 不计兼容通过；不得替换来源内容或放宽断言。最低检查为 test:screen、session-core 测试/严格 clippy、vt100 严格 clippy、全 fmt；准确区分未执行。原始/派生文本等不变量受影响时补测试并交 A 排 IPC。

C 执行 P11.4：按 ADR-032/033/035 建立已有覆盖/缺口表，只补本地特殊目标拒绝、原对象保持及发布失败边界。所有权为 selected_save 及测试、原生 export_save、Test-Desktop-Save 和必要恢复保存段、P11.4 记录。覆盖目录/只读、junction/reparse、应用数据子树、流语法/尾点/尾空格、私有暂存/备份/发布冲突、备份后发布失败与 RECOVERY_REQUIRED 的真实文件状态。最低为 terminal-log 测试/严格 clippy、fmt；改宿主追加宿主测试/严格 clippy，改前端追加 lint/test。仅自建中文前缀临时对象，不扩网络目标、跨重启授权或任意路径 RPC。

两份完整任务单已在 create_thread 初始 prompt 中发送，均含角色、Step-ID、绝对 cwd/分支、共同基线、文件所有权、验收命令、交付及接续条件。首轮要求先只读核对并 final 报告，A 核验后才放行。公共接口、协议、main.tsx、全局样式、Harness、依赖和治理文件由 A 指定单一修改者。EXECUTION_LOG/CHANGELOG 各分支仅追加自己事实，冲突由 A 集成保留。

## 启动工具实际情况

create_thread 的 local 环境仅绑定已保存项目目录；worktree 环境会新建目录，没有既有路径参数。A 先发现实际 schema，未通过错误的 worktree 环境额外建副本。用户协助以“打开已有文件夹”登记两处项目后，list_projects 实际确认：B 项目 d0178df3-3b53-4c4e-8cac-9010fcbb9b3f；C 项目 5c440cdd-c826-4daa-aa2b-2c89db479916；两者 path 精确匹配本表，均 isGitRepository=true。用户此前误建的“终端模拟器-reflow 2”是空仓库，A 仅只读核对，未删除或用于任务。

B 16:24:58、C 16:25:19 的创建请求返回 threadId，read_thread 元数据 cwd 正确。其后 wait_threads 尚未返回任何执行者 assistant/命令输出，状态为 active/inProgress；A 已各发送一次只读启动核验协调消息，没有重复创建。当前不声称执行成功，也不声称产品开发或验收通过。后续必须通过真实命令结果核验再更新本节。

16:28–16:29 续记：wait_threads 实际收到 B/C 的 completed/final 报告，两者实际 Get-Location、git status、HEAD、worktree 清单均与表中基线/分支匹配且干净；本地 target/node_modules/artifacts 不存在、无链接，CARGO_TARGET_DIR 未设置。没有编辑/测试/桌面进程。A 已分别发送正式放行消息，允许仅进程环境引用现有只读 Rust/Node 安装、Cargo 缓存遵循锁，输出仍独立；不修改全局配置。B 已完整读相关文档；C 报告长文截断，已要求分段补读再实施。当前为 DEVELOPING，不代表任何产品检查已通过。

## 共享资源与接续

当前未启动服务 IPC、原生构建、WebView、选择器、剪贴板或桌面自动化；无本批测试进程、无本批待释放资源。以后 A 记录占用者、准确源码/构建、起止和释放结果；最终源码构建后完整桌面回归，实际核对串口 finally 恢复普通服务。

从每个会话接管 HEAD 起两个实质提交后接续，或上下文难可靠维护时提前冻结；结束任务不凑提交。B/C 将冻结快照写各步骤记录，由 A 统一创建原项目 local 后继，旧会话冻结后不再写。A 自身后继用集成项目 local，核验同目录/分支/HEAD/dirty 归属后接管所有角色关系与资源队列。自动压缩不算接续，工具失败先查现场，不反复创建。

最小接续：先读本文件及台账；查询以上现有 B/C 会话（已核验放行），接续协调现有开发，不重新建 B/C/worktree。按手册逐提交审核与集成，分支证据不替代集成验证。P11.4/P11.7/P11/G1 和 P12–P25 准入均维持原状态。
