# 执行台账

更新：2026-11-03（Asia/Shanghai）。当前阶段：P01/P02 桌面骨架与合成渲染验证完成，尚无真实连接能力。下一步：P03。

DONE 的 Git 关联可以是实际短 hash 或 Step-ID trailer 查询；见 [变更管理](CHANGE_CONTROL.md)。Pxx 记录在开始该步骤时创建，不预填产品测试结果。

| Step-ID | 工作包 | 状态 | 记录 | Git 关联 |
|---|---|---|---|---|
| D01 | 需求/架构/25 步计划 | DONE | [D01](records/D01.md) | cd395c3 / Step-ID: D01 |
| D02 | AGENTS/治理/台账/模板/文档校验 | DONE | [D02](records/D02.md) | Step-ID: D02 |
| P01 | 环境与仓库骨架 | DONE | [P01](records/P01.md) | Step-ID: P01 |
| P02 | 终端渲染与输出原型 | DONE | [P02](records/P02.md) | Step-ID: P02 |
| P03 | SSH2 后端试验 | TODO | 待创建 | — |
| P04 | SSH1 兼容试验 | TODO | 待创建 | — |
| P05 | 串口底层试验 | TODO | 待创建 | — |
| P06 | Codex MCP 最小贯通 | TODO | 待创建 | — |
| P07 | 会话服务与 IPC | TODO | 待创建 | — |
| P08 | 配置与凭据 | TODO | 待创建 | — |
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
| G0 | TODO | 尚未技术验证 |
| G1 | TODO | 尚未基础应用 |
| G2 | TODO | 尚未真实 Codex 接入 |
| G3 | TODO | 尚未效率工具 |
| G4 | TODO | 尚未发布验收 |

## 当前问题

真实设备/服务器参数、SSH1 样本、UNIX 范围和 Codex 客户端策略待实施阶段核对。它们不阻塞 P01 本地环境调查，但会阻塞相关实机验收。
