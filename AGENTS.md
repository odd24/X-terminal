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
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
npm run desktop:build
npm run test:desktop
```

`npm run lint` 当前为 TypeScript 严格类型检查。P01 无业务单元用例，不以零用例测试宣称功能通过。`npm run desktop` 启动开发窗口。代码变更执行受影响的格式/静态/单元/集成检查；协议、调度、权限和迁移必须有实质测试。仅文档变更做文档检查，不为文字修改编写镜像测试。

## 结束工作

报告已完成的步骤、产物、验证、提交短 hash、未解决问题与下一步；工作区应干净，若用户已有修改保留并说明。未执行的检查明确写“未执行”。
