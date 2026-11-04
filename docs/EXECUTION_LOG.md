# 执行台账

更新：2026-11-04（Asia/Shanghai）。P01/P02/P06/P07 完成；P03–P05 软件阶段成果已提交、完整验收仍阻塞。按用户“后续验收”及 [CR-001](changes/CR-001.md)，继续独立软件工作，G0 完整验收未通过。P08.1/P08.2 完成；P08.3 后端与桌面编辑器已提交，继续主机密钥/备份恢复/凭据整理。

DONE 的 Git 关联可以是实际短 hash 或 Step-ID trailer 查询；见 [变更管理](CHANGE_CONTROL.md)。Pxx 记录在开始该步骤时创建，不预填产品测试结果。

| Step-ID | 工作包 | 状态 | 记录 | Git 关联 |
|---|---|---|---|---|
| D01 | 需求/架构/25 步计划 | DONE | [D01](records/D01.md) | cd395c3 / Step-ID: D01 |
| D02 | AGENTS/治理/台账/模板/文档校验 | DONE | [D02](records/D02.md) | Step-ID: D02 |
| D03 | 实机后验收与独立开发准入 CR-001 | DONE | [D03](records/D03.md) | Step-ID: D03 |
| P01 | 环境与仓库骨架 | DONE | [P01](records/P01.md) | Step-ID: P01 |
| P02 | 终端渲染与输出原型 | DONE | [P02](records/P02.md) | Step-ID: P02 |
| P03 | SSH2 后端试验 | BLOCKED | [P03](records/P03.md) | Step-ID: P03 |
| P04 | SSH1 兼容试验 | BLOCKED | [P04](records/P04.md) | Step-ID: P04 |
| P05 | 串口底层试验 | BLOCKED | [P05](records/P05.md) | Step-ID: P05 |
| P06 | Codex MCP 最小贯通 | DONE | [P06](records/P06.md) | Step-ID: P06 |
| P07 | 会话服务与 IPC | DONE | [P07](records/P07.md) | Step-ID: P07 |
| P07.1 | 会话领域与 IPC 契约 | DONE | [P07.1](records/P07.1.md) | Step-ID: P07.1 |
| P07.2 | Windows 受限服务与 Named Pipe | DONE | [P07.2](records/P07.2.md) | Step-ID: P07.2 |
| P07.3 | 桌面共享服务生命周期 | DONE | [P07.3](records/P07.3.md) | Step-ID: P07.3 |
| P08 | 配置与凭据 | IN_PROGRESS | 待子步骤完成后汇总 | — |
| P08.1 | 配置模型与 SQLite 迁移 | DONE | [P08.1](records/P08.1.md) | Step-ID: P08.1 |
| P08.2 | Windows 保护凭据 | DONE | [P08.2](records/P08.2.md) | Step-ID: P08.2 |
| P08.3 | 配置服务/编辑器/主机密钥与恢复存储层；备份 UI/凭据整理继续 | IN_PROGRESS | [P08.3](records/P08.3.md) | Step-ID: P08.3 |
| P09 | SSH2 正式接入 | TODO | 待创建 | — |
| P10 | 串口正式接入 | TODO | 待创建 | — |
| P11 | 编码/日志/终端行为 | TODO | 待创建 | — |
| P12 | 基础桌面体验 | TODO | 待创建 | — |
| P13 | SSH1 正式兼容 | TODO | 待创建 | — |
| P14 | Agent 授权与调度 | TODO | 待创建 | — |
| P15 | MCP 工具实现 | TODO | 待创建 | — |
| P16 | Codex 真机闭环 | TODO | 待创建 | — |
| P17 | 标签组与工作区 | TODO | 待创建 | — |
| P18 | 同步输入 | TODO | 待创建 | — |
| P19 | 快速命令/完整撰写窗格 | TODO | 待创建 | — |
| P20 | 触发器 | TODO | 待创建 | — |
| P21 | 批量管理与迁移 | TODO | 待创建 | — |
| P22 | 压力与权限边界 | TODO | 待创建 | — |
| P23 | 兼容与真实试用 | TODO | 待创建 | — |
| P24 | 故障恢复与升级 | TODO | 待创建 | — |
| P25 | 安装与发布验收 | TODO | 待创建 | — |

## 阶段门

| 门 | 状态 | 证据 |
|---|---|---|
| G0 | TODO | P01/P02/P06 已验证；P03–P05 完整验收未齐。[CR-001](changes/CR-001.md) 允许独立软件开发先行，不代表本门通过 |
| G1 | TODO | 尚未基础应用 |
| G2 | TODO | 尚未真实 Codex 接入 |
| G3 | TODO | 尚未效率工具 |
| G4 | TODO | 尚未发布验收 |

## 当前问题

真实设备/服务器参数、SSH1 样本、UNIX 范围和 Codex 客户端策略待核对。P03 真实端点测试未执行；P04 还缺少可传递 resize/安全凭据的完整 Windows SSH1 适配器，原版 Plink 管道不能满足。P07 的协议中立服务/桌面合成会话已验证，真实传输、后台选择、持久配置、完整 Agent 授权仍留后续步骤。按 CR-001 继续 P08 独立软件实现，G0 完整验收仍未通过。
