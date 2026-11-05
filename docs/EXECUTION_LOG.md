# 执行台账

更新：2026-11-05（Asia/Shanghai）。P01/P02/P06/P07 完成；P03–P05 软件阶段成果已提交、完整验收仍阻塞。按用户“后续验收”及 [CR-001](changes/CR-001.md)，继续独立软件工作，G0 完整验收未通过。P08 三个子步骤及汇总完成，已追加运行中 schema 写保护；P09 服务建立/认证/读写/resize/exec/显式重连已接入，桌面连接/认证/终端输入/尺寸已接入，exec 桌面任务与输入/任务/建连有界窗口、结束连接显式移除已实现；真实端点/长期稳定性待验，继续独立软件步骤。P11.1完成桌面串口增量接收解码与输出缺口/跨连接控制解析隔离；P11.2完成服务派生文本与screen软件范围；P11.3独立有界日志引擎已验证；P11.4已接入服务捕获和桌面启停/状态，已完成日志文件侧的不可变读取/跨段校验/分页已验证（日志库26项）；历史目录/读取IPC已接入独立有界文件线程，桌面历史分页/HEX与跨记录全文字面搜索已验证，文件库JSONL导出流及受管理同步/不覆盖发布、Desktop专用导出任务已验证（三包117项及原生通道专项），桌面受管理JSONL导出/完整路径/任务查询已通过完整桌面回归，Windows文件库的句柄整理预览/部分失败报告已验证46项日志库测试（ADR-031）；Desktop专用有界整理服务/确认到期/REMOVED与回执水位已验证相关三包138项；桌面清理选择/预览/确认、到期/取消及应答不明恢复已通过原生专项与完整桌面回归；失败捕获RELEASED纯元数据关联与capture_list跨连接/旧代次清单已接入，相关两包98项、无连接原生维护及完整桌面回归已通过，按编号保留未知状态后又重构建/专项复验通过；自选保存来源的生产指纹/回执及Windows验证复制已通过三包151项，原生导出指纹核对及完整桌面回归通过；自选位置/目标发布/打开目录、失败前缀恢复、完整持久日志体验和reflow仍开放。

DONE 的 Git 关联可以是实际短 hash 或 Step-ID trailer 查询；见 [变更管理](CHANGE_CONTROL.md)。Pxx 记录在开始该步骤时创建，不预填产品测试结果。

| Step-ID | 工作包 | 状态 | 记录 | Git 关联 |
|---|---|---|---|---|
| D01 | 需求/架构/25 步计划 | DONE | [D01](records/D01.md) | cd395c3 / Step-ID: D01 |
| D02 | AGENTS/治理/台账/模板/文档校验 | DONE | [D02](records/D02.md) | Step-ID: D02 |
| D03 | 实机后验收与独立开发准入 CR-001 | DONE | [D03](records/D03.md) | Step-ID: D03 |
| D04 | 现代简洁界面与全局样式/字体统一规则 CR-002 | DONE | [D04](records/D04.md) | Step-ID: D04 |
| D04.1 | 常用 Xshell 界面操作参考与验收细化 | DONE | [D04.1](records/D04.1.md) | Step-ID: D04.1 |
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
| P08 | 配置与凭据 | DONE | [P08](records/P08.md) | Step-ID: P08 |
| P08.1 | 配置模型与 SQLite 迁移 | DONE | [P08.1](records/P08.1.md) | Step-ID: P08.1 |
| P08.2 | Windows 保护凭据 | DONE | [P08.2](records/P08.2.md) | Step-ID: P08.2 |
| P08.3 | 配置服务/编辑器/主机密钥/备份恢复/凭据整理 | DONE | [P08.3](records/P08.3.md) | Step-ID: P08.3 |
| P09 | SSH2 正式接入（服务/终端/任务 GUI、rekey、输入/任务/建连窗口及连接移除；实机/长稳待验） | IN_PROGRESS | [P09](records/P09.md) | Step-ID: P09 |
| P10 | 串口正式接入（身份/I/O/服务/GUI/发送软件已验证；接收解码见P11.1，日志/实机继续） | IN_PROGRESS | [P10](records/P10.md) | Step-ID: P10 |
| P11 | 编码/日志/终端行为 | IN_PROGRESS | [P11](records/P11.md) | Step-ID: P11.1 / Step-ID: P11.2 |
| P11.1 | 桌面增量接收解码 | DONE | [P11.1](records/P11.1.md) | Step-ID: P11.1 |
| P11.2 | 服务派生文本与屏幕 | DONE | [P11.2](records/P11.2.md) | Step-ID: P11.2 |
| P11.3 | 有界持久日志引擎 | DONE | [P11.3](records/P11.3.md) | Step-ID: P11.3 |
| P11.4 | 日志服务与桌面入口 | IN_PROGRESS | [P11.4](records/P11.4.md) | Step-ID: P11.4 |
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

真实设备/服务器参数、SSH1 样本、UNIX 范围和 Codex 客户端策略待核对。P03 真实端点测试未执行；P04 还缺少可传递 resize/安全凭据的完整 Windows SSH1 适配器，原版 Plink 管道不能满足。P07 的协议中立服务/桌面合成会话已验证，P08 配置/凭据已完成软件范围；P09 已有 SSH2 服务与 GUI 软件证据，SSH2 实机、SSH1/SERIAL 正式接入、后台选择和完整 Agent 授权仍待后续步骤。按 CR-001 继续 P09 独立软件实现，G0 完整验收仍未通过。
