# 执行、提交与变更管理

## 状态与责任

执行者负责实现/记录，验证者可以是同一执行者但必须提供可复查证据；产品范围由用户指令决定。当前不设置额外强制人工审批门，以免阻碍已经授权的常规工作。

状态：TODO → IN_PROGRESS → DONE；无法继续时 BLOCKED；修复后返回 IN_PROGRESS。取消用 CANCELLED，必须关联 CR。DONE 必须产物、验证、记录与本地提交均存在。已完成步骤回退后改为 REVERTED 或重新 IN_PROGRESS，保留原记录。

台账是状态入口，步骤记录是证据，Git 是变更事实来源，CHANGELOG 是面向使用者的变化摘要；四者不能互相替代。

多会话执行按 [CR-003](changes/CR-003.md) / [并行手册](PARALLEL_EXECUTION.md)：执行会话独立worktree与文件所有权，真实IPC/桌面时段由统筹排队；每步提交要求不变，公共台账冲突由统筹保留双方事实。交付需给出准确提交和本地证据绝对路径，集成逐提交审核/验证；首次归档不代表并行已启动，也不新增用户审批门。

## 一步的标准流程

1. 检查工作区与前置条件，确定 Step-ID；需要拆分时先登记 Pxx.1 等子步骤。
2. 在步骤记录填写目标、基线、范围和预计验证，执行实现/试验。
3. 运行适当检查；保存命令、实际结果和脱敏证据。失败时修复或如实记录阻塞。
4. 更新需求/接口/测试变化；更新台账状态、步骤记录与 CHANGELOG。
5. 文档检查可临时用 `-PendingStep <ID>`；代码检查按真实脚本运行。
6. `git add -- <明确文件>`，核对暂存内容与 `git diff --cached --check`。
7. 本地提交，包含 `Step-ID: <ID>` trailer；修改需求时另附 `Change-ID: CR-xxx`，架构可附 `Decision-ID: ADR-xxx`。
8. 用 Git 历史核对提交，无 pending 豁免复查文档；检查工作区。若失败用后续修正提交，不伪造通过。

提交示例：

```powershell
git commit -m "feat(P09): integrate ssh2 sessions" -m "Step-ID: P09"
git log --all --format=fuller --grep='^Step-ID: P09$'
```

每步可有多个提交，全部携带同一 Step-ID；独立修复子步骤则使用自己的 ID 并关联父步骤。一个提交只归一个主步骤，避免无法对应执行记录。

## 提交 hash 的自引用处理

提交内容不能包含它自身最终 hash。步骤记录使用 Step-ID 和 Git trailer 定位当前提交；后续步骤可回填已存在 hash。台账的 `Git 关联` 字段可填写已知 hash 或 `Step-ID: D02` 等选择器，两者都可追溯；不得编造 hash，也无需不断 amend 来填 hash。

步骤记录可以在准备提交时写 DONE，但该状态只在提交成功后成立。提交失败保持/恢复 IN_PROGRESS；未提交的 DONE 不作为交付依据。校验脚本的 pending 选项仅服务此短暂窗口。

## CR：范围、验收、排期变更

使用 `docs/templates/CHANGE_REQUEST.md` 复制到 `docs/changes/CR-xxx.md`。记录来源、原需求、新需求、理由、影响步骤/测试/时间/兼容性、回退和状态。CR 状态：PROPOSED / ACCEPTED / IMPLEMENTED / REJECTED / SUPERSEDED。

用户明确提出的变更可直接记 ACCEPTED 并引用原话；常规实现不额外请求批准。若需删减 SSH1 等明确需求或更改用户全局配置且尚未获授权，先完成可审阅方案，再澄清具体缺口。

不要覆盖历史结论；作废时用 superseded 指向新记录。提高/降低验收阈值都保留原始测量数据。

## ADR：技术决策

使用 `docs/templates/ADR.md`，创建 `docs/decisions/ADR-xxx.md`。记录场景、约束、候选、证据、决定、后果和回退。状态为 PROPOSED / ACCEPTED / SUPERSEDED。涉及范围变化时同时 CR；仅版本更新但行为不变可在执行记录说明，无需冗余 ADR。

## 缺陷与回退

缺陷记录在相关步骤，分配 BUG-xxx；包含严重度、复现、预期/实际、发现 commit、修复步骤、回归证据。重复出现或跨步骤问题可独立建记录。

代码回退优先新增 `git revert <hash>` 后补齐记录；数据库先备份再恢复，凭据存储不随 Git 回退。远程命令无通用回滚，运行前明确目标和范围，已执行动作的补偿按实际设备处理。

## 文件维护责任表

| 变化 | 必须维护 |
|---|---|
| 步骤开始/完成/阻塞 | EXECUTION_LOG + records/步骤 |
| 需求范围/验收变化 | CR + REQUIREMENTS + EXECUTION_PLAN + TEST_PLAN + CHANGELOG |
| 技术架构改变 | ADR + ARCHITECTURE + 受影响接口/步骤 |
| Codex 接入或接口改变 | CODEX_INTEGRATION + schema/契约测试 + 执行记录 |
| 构建/检查命令改变 | AGENTS + README/开发说明 + 执行记录 |
| 发布/升级行为改变 | CHANGELOG + 用户/升级说明 + 发布验收 |
