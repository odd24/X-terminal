# 仓库执行规则

2026-11-09当前优先CR-015/P12.1现场配置锁滞留修复，暂停无关S3。当前只读单桌面35428/子服务20816，17:26锁无人且只读共享打开成功、17:27 UI仍旧LOCKED；旧2052/19560已不存在，不能追认启动时占用者。ADR-075新增显式同service_id Recheck，仅原Locked重试固定根独占锁；普通读不接管、已就绪不重开，库损坏/未来版本不重置，未自动保存/登录/开COM。共享SSH/UART复查与输入保持、配置/端口清单失败分开；第40入口test:desktop:config-recheck仅中文自建根/内存库存，finally普通服务实际恢复。旧“LOCKED必须重启”按历史版本理解；高级审计启动失败不在本包恢复，Agent失败封闭保持。详见P12.1/CR-015，不关闭用户窗口、不删锁/库、不探测COM89。

2026-11-09 P11.4/CR-014右键日志菜单软件包已完成第39入口test:desktop:log-menu：直接起停、共用logs目录/实际活跃文件、全部轮次完整已刷新前缀与实际上滚viewport导出，保留缓冲另名；旧右键自动粘贴停用、显式菜单/热键保持。新菜单render即按本次context加载状态禁用，原ID未知只查/重载不自动续存/同原代次显式续存；切换/重连/关闭撤自动步，不改投。原生Explorer/Notepad正文头核对、系统另存/取消/覆盖备份/SHA、超预览全文及精确屏幕字节已验，串口finally普通恢复实际成功；不把此包当完整P11.4/实机/全局验收。前置后端53886a0，最终影响回归及新预览见P11.4，自动审查拒绝的旧自建根继续保留不绕过。

2026-11-09 P11.4/CR-014最新追加实时/统一目录/命名已完成后端软件子包，菜单尚在途：所有标签/窗格/轮次平铺现行数据根logs，服务冻结SSH host/UART port及北京时间起录秒，严格窗口名_YYYY-MM-DD_HH_mm_ss.log，同名同秒仅冲突_1；裸COM7加时间后合法，不多加前缀。原worker100ms目标flush/1秒sync，水位分列，独立64文件/每份256MiB有界且CAPACITY区别DISK_FULL；内部raw/JSONL不移不删，清理内部不自动删用户文本。活跃全部已录可导出固定完整已刷新前缀，录制继续；显示缓冲/viewport另类。第38入口test:desktop:log-files前置实际构建，只中文自建根/两个合成SSH/被动内存UART，finally普通恢复已成功。下一接共享右键菜单与实际GUI专项，不把基础函数/后端通过当六入口交付，详见P11.4/ADR-074；一处旧失败WebView自建根清理被自动审查拒绝而保留，不绕过。

2026-11-09最新优先P11.4/CR-014终端右键基本日志包：SSH/UART与双窗格实际右键目标冻结，起停/可信目录/已停止完整可读文本/全部已录保留范围/真实滚动viewport六入口；活跃不静默停，明确另名保留缓冲导出；右键不再自动粘贴，快捷键保持。独立子产物提交，先完整规划再原生/菜单/专项，未知原编号只查。真实Android日志私有不作fixture，不新增Agent/常规审批，详见CR-014及P11.4记录。

2026-11-09 P10.1最新98bb37c小read修复已软件验证并交付15b81f61普通预览，一次COM89/1500000正常UI只接收复验日志37.996秒/10560字节/0已报告源缺口；停止同步、断开和独立桌面/普通服务退出确认释放。本轮不反复开COM，原始日志仍私有，不能推导全部负载无损或完整S2通过，最新边界见P10.1记录；旧4357缺口是修复前历史事实。

2026-11-09 P10.1串口小read源缺口按ADR-073优先修复：纯合成8329单字节旧版丢8313，原短锁内最多16个4096字节块连续尾部合并，两条接收路径共用，消费者额外1块；满载不等消费者，精确Gap和取消join尾部保留。详细构建/分层验证/实机复验结果只据P10.1记录，不扩大为所有负载无损；不改变接线、控制线或发送权限。

2026-11-09最新硬件状态覆盖旧“暂无设备”：用户已连Android ADB+UART，指定1500000，并确认仅TX/RX/GND、DTR/RTS未接。已只读识别唯一COM89 CH340及在线ADB，普通独立软件/UI做首次只接收和受管理日志（非Harness/fixture/真实业务命令），已断开并正常退出释放。存在实际源缺口，不能称完整实机通过；参数/计数/私有日志位置及下一软件隔离见docs/records/P10.1.md最新节。原始设备日志不入Git，未授权设备写操作/复位/ADB shell，已有用户窗口不动。

2026-11-08持续推进已完成S1/P12.1与S2/P10.1软件阶段，用户明确暂时没有UART设备，真实COM/板端继续待验。当前S3/P17已完成窗口内分组和受管理布局保存/打开软件子包；schema5仅配置引用/组/顺序/有限视图，打开不自动连接，临时会话不保存；新身份沿原SSH/串口流程。test:desktop:workspaces为第26入口，前置实际构建、只中文自建根/合成SSH/内存串口，finally实际恢复普通服务。分屏已按ADR-064完成单窗格抽取和本窗口左右/上下双窗格软件验证；独立精确身份/输出/队列/尺寸，焦点统一工具、F6、收起保留连接。test:desktop:split为第27入口，前置实际构建，只中文自建根/合成SSH/内存串口，finally实际恢复普通服务。持久分屏也已按ADR-065软件验证：schema6只方向/两个布局项引用，活动项复用selected_tab，v5独立只读/事务迁移与备份；每次打开清旧布局绑定、显式两目标连接后一次恢复，手动选择/关闭目标/改布局取消待恢复，不跟随新代次。test:desktop:workspace-split为第28入口，只中文自建根/合成SSH/内存串口且finally实际恢复普通服务。完整P17/R06与全局矩阵仍不冒称收口，不重做已有界面、不并行扩广播/触发器。旧S1/S2“当前”按各自历史理解，主方案与分层证据为准。

2026-11-08用户明确“继续持续推进方案”：S1/P12.1按现有证据完成软件阶段收尾，当前顺序进入S2/P10.1简洁串口/UART和基本日志，不再仅因等待新版反馈停工。较早“当前只P12.1/不扩S2”按历史理解。软件、内存IPC和真实COM分别记录，缺硬件只阻塞对应实机验证；不擅开真实COM或发设备命令。仍一次一个阶段、唯一写入者、不新增Agent/审批；完整验收边界保留。

2026-11-08最新[CR-009](docs/changes/CR-009.md)覆盖旧会话关闭确认三选一：标签直接对完整原代次关闭/隐藏，无确认；程序退出/配置日志删除规则不变。保存SSH2双击/右键连接统一本次意图/固定request_id，同步在途门防快速重复，可用保护凭据自动尝试一次；缺失/拒绝才补录，必要指纹不省略，未知只查不重放。右键目标与选中一致；隐藏按代次隔离，迟到旧应答不能影响新代次。当前只P12.1/S1，串口仍按原身份/控制线核对；第16导航专项更新到新语义，历史旧确认/保留证据仅按原版本理解。

P12.1现场LOCKED故障：同一默认配置根同时开旧/新预览会被原独占锁拒绝，不能吞错误、旁路锁或自动关闭用户旧会话。ConfigRequestError只保留白名单安全原因/是否不明，连接弹窗区分配置读取/保存与SSH阶段；读失败禁Start，保存失败说明尚未SSH，丢保存应答只读核对、不重放/自动续接。第23入口test:desktop:quick-config只自建双服务根/合成SSH；真实用户目录不指向Harness。具体证据集中P12.1，继续S1而不展开S2。

2026-11-08用户实际SSH成功后按[CR-008](docs/changes/CR-008.md)继续P12.1：连接服务器/连接配置/外观统一居中模态弹窗，会话导航保留；SSH标签只显示该代次真实服务器地址，完整身份在tooltip/详情，同地址不合并。失败在弹窗内用明显role=alert说明安全可知原因及下一步，未知网络大类不冒称精确原因，应答不明原编号只查。用户已授权经正常流程使用已有保存凭据测试，不导出/打印秘密、不将合成Harness指向用户目录，不关闭用户已有会话或操作远端业务；真实/合成证据分列。新test:desktop:ssh-dialog前置实际构建，完整第22入口；测试WebView目录限自建根隔离，配置弹窗全局方向与其余旧入口待迁移边界见记录，不展开S2或全应用重做。

2026-11-08 P12.1已实施简洁SSH2单表单直连与基础UTF-8文本日志，服务基础提交2543aa7，实际desktop:build后新流程/真实系统保存软件专项PASS，详情[记录](docs/records/P12.1.md)。授权服务器试用未执行，S1保留IN_PROGRESS，只继续该验证/反馈，不展开S2；下述D07/D08“仅方案/尚未实施”为当时事实。新增test:desktop:quick-ssh，前置实际desktop:build，完整第21入口，合成SSH/自建中文前缀根及保存根，不改既有1–20编号。当前目标始终SSH工作、UART通信/抓取、两者基本日志与简洁操作；高级能力保持按需收起，必要安全不减。

2026-11-08主要需求固定为[CR-007](docs/changes/CR-007.md)：类似Xshell的SSH服务器工作、串口/UART通信或只接收抓取设备信息（含Android UART log）、两者基本通信日志。初版简洁、逻辑清晰，主界面围绕SSH连接/串口连接/日志；基本日志随S1 SSH和S2 UART各自验收，不延后到高级日志。复用已有日志服务/安全落盘，明确实际记录范围，不记录认证表单秘密、不臆称未记录的发送；高级Agent/MCP/审计/exec/日志维护后置。沿下述CR-006逐阶段顺序，详细条件仅维护主方案；本轮D08只归档需求，下一实现仍P12.1。

2026-11-08最新以[CR-006](docs/changes/CR-006.md)和[EXECUTION_PLAN现行路线](docs/EXECUTION_PLAN.md#现行路线cr-006)为唯一当前入口：先做好简洁SSH2直接登录与基本使用（P12.1），阶段验收达成后再做串口（P10.1），之后逐阶段推进多会话/效率、高级日志/Codex、SSH1兼容及正式交付。最终R01–R16不变，旧编号/能力/数据/验收事实保留复用；旧P15/P16主线与初版收口不代表新SSH体验完成。一次只推进一个用户阶段，不新增并行/顾问审批，不立即全应用重做；本次D07仅方案文档，S1尚未实施。主入口可见、单表单、保存可选、同流程身份/认证及进入终端是下一包目标，高级Agent/MCP/审计按需收起，必要安全不减。下列旧增量按原阶段理解，当前顺序以CR-006覆盖；按影响最小验证，无变化不重跑旧套。

P15初版按ADR-059使用当前用户Pipe/OS桥PID与同目录映像、30秒一次固定原签发预览；原生持独立Agent Client，stdio不持bearer，不得借Desktop bootstrap转发。只9个读/屏幕/文本发与lease/回执工具，保护票据强制ProtectedContext；原生Agent IO失效关闭流，UNKNOWN_DELIVERY不重放。test:desktop:mcp前置desktop:build，完整第20入口，只shared-terminal-mcp-ui-中文-自建根/合成SSH/内存串口，finally实际恢复普通服务。初版最小P15已验证可直接进P16，完整工具/实机/全局矩阵留后续，不扩初版门槛。

2026-11-07初版优先级以[CR-005](docs/changes/CR-005.md)为准：尽快交付可用初版，P14在途必要收尾后优先P15/P16最小安全共享会话闭环与基本交付检查；一般完善转迭代，不再把全部R01–R16/P01–P25作为本版结束门槛，未完需求保留且不得冒称完整v1通过。只有实际越权/秘密泄露/用户数据损坏/基本路径不可用才阻塞；必要安全不削减，按影响最小必要验证，无变更/失败/实质风险不重跑旧套，不追加精修或常规审批。

P14审计按ADR-058分RPC尝试与Policy事件直接typed送入独立terminal-audit有界JSONL（8段各1MiB/1024条、1024队列），accepted不等于synced，轮转/内部缺号/坏尾/失败明确；仅自身独占已验证句柄退休审计段，不触及终端日志/配置/用户文件。已知故障拒绝新Agent许可/派发及完整/窗口新正文读取，窗口fallback不得吞CapacityExceeded；原编号回执/本人原任务结果/释放/撤销/接管保留，不能撤回已开始动作。Desktop历史独立只读白名单、精确整数文本/固定同步水位，关闭重载不自动读取；test:desktop:agent实际fetch故障/原生投影与串口finally普通恢复按P14记录，不从审计历史恢复授权或推断真实stdio桥完成。

P14保护批准GUI复用共享OutputProtectionEditor/Preview，Read/Task与单次Exec显式启用（默认未启用，启用后字段默认开/无精确规则）；完整有序规则/模式冻结、控制及bidi转义预览，编辑/切换/关闭/重载撤同意。原生严格GrantProtected仍剥离token，回执只策略ID/模式/数量，规则不持久化/不恢复；真实fetch故障/两协议GUI见P14，签发不执行或交真实桥。默认截图不代表全局UI矩阵。

P14保护输出按ADR-057冻结票据策略，GrantProtected仅不透明ID/模式/数量回执、私有带盐等值校验，规则不入日志/审计/WebView回执。受保护票据旧Read/ReadText/Screen/Context/ExecRead统一拒绝；ProtectedContext和本人ExecReadProtected先完整授权段/独立流保护再源游标分页，远端exit_signal的Start重试/Status/Cancel也同策略。屏幕命中整行、控制或未知字段前文整屏隐藏，保持原始缓冲/日志；不把保守隐藏当同宽逐字DLP，GUI保护批准/真实桥独立交付。

P14脱敏按ADR-057先建有界字段/精确文本引擎，规则Zeroizing且不输出值/摘要，整授权连续段先处理再分页，截断与活跃尾部保守保护，gap/时间排除/exec双流分段；不透明控制整段隐藏。字节保持不等同列宽屏幕，后续须同票据策略/原回执匹配与Raw/Text/Screen/Context/ExecRead全入口防绕过，不能回退原文；核心测试不当服务/GUI或真实桥已保护。

P14授权形式GUI按ADR-056新增严格GrantTask/GrantOperation白名单，Task说明/Single动作默认空、无同意；Single预览原编号/全部参数/固定配置与设备/代次编码，WebView独立核对规范指纹和scopes。配置确认前重读revision，串口库存只显式读取冻结，重读会换版本；批准不建连/发送/控制/关闭/移除或取lease。正文/同意不持久化，仍只service_id/request_id恢复，native剥离token。14单动作及两个新op真实故障与最终构建/原生证据见P14，不当stdio桥/COM或全局Mac+DPIIME验收。

P14单次/限时任务服务按ADR-056使用GrantOperation完整严格请求和GrantTask任务信息，管理原编号恢复匹配Form/任务/参数且不续期；所有真正Single变更重算协议包装指纹并绑定局部Identity，原Manager负责原owner/精确代次去重。状态/本人任务读取取消不冒充新变更，退休/配置删除仍可用有效票据恢复原编号；Reconnect签发核对原Profile。服务IPC/内存worker不等GUI完整预览或真实stdio桥，普通服务恢复及最终证据见P14。

P14单次/限时任务按ADR-056先建核心Form，Single固定request_id/规范参数摘要，原始认证身份无绑定证明不得admit；最终Permit按同grant/编号/scope/lease复核，分片/首poll沿原许可，去重仍由原owner/精确代次有界回执负责。TimedTask编号/说明不授权。服务必须重算真正请求，固定配置版本/完整参数预览、各动作IPC和GUI未验证前不得以核心通过宣称新形式可用或真实桥交付。

P14时间窗GUI按ADR-055复用共享Panel/Field/tokens，Read默认无勾选、窗口时间默认空，显式北京时间UTC+08半开毫秒范围/重建语义；预览绑定服务/协议/完整代次/当时状态，编辑/切换/关闭/重载不恢复同意或时间，只保留签发编号。已结束SSH2/SERIAL的Read/Forget分别批准。两协议原生/最终文案后构建与专项及普通服务恢复见P14，非真实stdio桥/COM或Mac全局DPIIME验收。

P14时间窗按ADR-055以独立OutputWindow Read和Context Info/Raw/Text/Screen接入，旧完整读取不接受窗口票据；请求窗口须单项包含，固定原始exclusive through_cursor分页，文本游标也用源seq。先过滤原始事件再从空解码/屏幕状态重建，覆盖/上下文断开显式；范围屏幕非完整实时终端，snapshot完成不等源结束。窗口不授lease/变更，接管保留Read、退休撤下精确代次；GUI/真实桥按实际记录独立验证，不将时间过滤当脱敏。

P14 Forget GUI仅已结束SSH2/SERIAL代次开放独立FORGET，默认无勾选/同意，固定完整代次/期限且批准不执行移除/不取lease。共享Panel/Field/tokens，取消/切换/预览重载/单次及真实fetch丢应答只查/迟到关闭覆盖第19两协议；最终固定源码完整19入口与两次串口普通服务恢复见P14。Removed不删日志/配置/用户文件，实际token交stdio桥/COM及全局DPIIME仍独立验收。

2026-11-07用户授权执行优化生效，覆盖旧流程：完整能力统一规划协议/服务/GUI/测试，独立产物仍分别提交；仅完整工作包结束且确需续聊或上下文已难可靠维护时交接，不再每两个提交强制换聊天，自动压缩可原聊天继续。唯一写入者及必要交接核验保持。按影响分层验证，最终固定源码完整回归已覆盖的专项不重复跑，无新变化/失败/风险不重跑全套；产品变化仍先实际desktop:build，串口finally普通服务须实际恢复。详细证据集中步骤记录，台账仅状态/结论/链接，CHANGELOG面向用户。GUI不稳定先诊断定位再专项修复，不放宽断言或掩盖重试。从Forget起连续三个能力包记录实现/构建测试/排障/文档交接时间及回归次数/失败原因，估计须标注，不虚构基线或提速比例。完整R01–R16/P01–P25、依赖、安全边界、SSH1及实机验收不缩减，不新增并行Agent。现行细则见docs/CHANGE_CONTROL.md、组织证据见docs/records/D05.md。

P14串口Forget按ADR-054独立Forget/lease及ForgetStart/ForgetStatus原owner完成回执，同锁核对实际worker join且无未结ticket后才移除；join回报丢失/容量失败拒绝且无成功回执，可原编号重试，不取消活跃worker。旧无编号Forget仍Desktop专用；Removed不删日志/配置/用户文件，退休后原有效ticket原编号只查。内存feature IPC不当COM，实际desktop:build及串口finally普通服务恢复仍须验证，GUI/真实桥独立交付。

P14 SSH Forget按ADR-054独立Forget/lease与ForgetStart/ForgetStatus原owner完成回执，旧无编号Forget仍Desktop专用。gate等待后重验同许可，仅Actor实际结束且共享传输引用释放才移除；清理未完InvalidState且无成功回执，可原编号重试，不取消活跃传输。Removed不删除日志/配置/用户文件，退休后原有效ticket原编号只查；串口/GUI/真实stdio桥独立交付。

P14 SSH Reconnect按ADR-053独立旧代次Reconnect/lease与固定Profile/revision Connect双许可，gate/配置/清理await后重验，原owner原编号优先只查；推进generation退役旧范围，新Actor首poll仍核对独立Connect，不继承旧lease/读写/认证。共享Agent授权GUI以单次预览批准旧SSH代次+原配置revision双范围，批准本身不重连；test:desktop:agent合成SSH覆盖，真实stdio桥/Forget继续独立交付。

P14配置建连GUI按ADR-052独立选择已保存SSH2/SERIAL的profile_revision Connect，默认无目标/无同意、固定配置参数/期限，批准前重读同revision且不建连；串口初始DTR/RTS明确。第19两协议专项覆盖编辑/删除/重载/真实fetch丢应答/关闭迟到，只Agent中文前缀根且串口finally实际恢复普通服务；真实stdio桥仍独立交付。


P14 Profile Connect按ADR-052新增profile_revision固定配置库版本目标，仅Connect；原profile ID范围不冒充固定版本。Start原编号优先只查，配置线程匹配revision后返回不可变Profile快照，await后与实际派发前仍复核同许可；库变更保守阻止后续新Start，在途快照不混用新参数。GUI须明确串口初始DTR/RTS，不从服务路径推导批准或真实stdio桥。


P14授权GUI新增SSH2/SERIAL独立Disconnect，默认无勾选、固定代次/期限且批准不关闭连接；Requested/TransportEnded语义持续明确，接管撤下Disconnect。test:desktop:agent第19入口含SSH与独立内存串口GUI，串口Agent专项仅shared-terminal-agent-ui-中文-自建根并finally实际恢复普通服务；不得将原生Desktop关闭测试冒充Agent token已交真实stdio桥。Profile Connect批准/真实桥仍独立推进。

P14串口Disconnect按ADR-051独立范围/lease和原owner编号回执接入，只有OS worker实际join回报可标TransportEnded；join回报通道丢失保持Requested/cleanup_pending并拒绝Forget。tick及Forget前保存精确代次终态，guard等待中取消不得再open；内存feature IPC不等于COM验收，之后须实际desktop:build与串口finally普通服务恢复。旧Close仍Desktop专用，GUI/真实桥独立交付。

P14 SSH Disconnect按ADR-051使用独立Disconnect/lease及严格原编号/owner回执；Requested不等于本地传输结束，Actor结束且共享传输引用释放才可TransportEnded。退休/Forget后有效ticket原编号只查，不续租或再次关闭；旧无编号Close仍Desktop专用。串口Disconnect、GUI批准和真实stdio桥须独立验证，不从SSH路径推导。

P14串口Start按ADR-050绑定原回执owner/精确Profile Connect，配置await后与OS worker实际打开前复核；库存revision/device_id/端口匹配及占用仍必需，guard等待期间Close后不得再open。仅合成内存端口/中文前缀根，feature IPC后实际desktop:build恢复普通服务；Connect不推导Read/Write/Control/Disconnect、库存枚举或GUI/真实桥交付。

P14 SSH Start按ADR-049绑定原Start回执认证owner，Profile Connect不授新连接Read/Write/认证批准；配置await后及实际连接future首次poll重验同许可。SSH Reconnect服务与双范围GUI批准按ADR-053已接入；Agent Forget仍待独立接入，串口Start/Disconnect不得互相推导，服务/GUI批准不代表真实stdio桥。

P14尺寸控制按ADR-048接SSH2 Control/lease及原FIFO/认证回执，Desktop视口调整不接管；test:desktop:agent扩展READ+WRITE+CONTROL默认无勾选/固定范围和接管后仅Read，仍须前置实际desktop:build。Control仅按目标协议为SSH尺寸或串口控制线，不推导Connect/Disconnect/广播或真实MCP桥交付。

P14授权GUI扩展test:desktop:agent，前置desktop:build与gui_ssh_fixture（npm入口会编译），覆盖实际合成SSH的固定代次/READ+WRITE批准、默认无勾选/取消/切换/一次性、接管后有效范围、撤销与签发真实fetch丢应答命中、只编号重载/预览重载不签发、关闭迟到及512审计环覆盖分页。token仍不入WebView；原生/GUI批准不代表真实stdio桥交付，默认深浅截图不能替代全局DPI/输入法。只shared-terminal-agent-ui-中文-临时根，不接实机。

P14管理通道新增npm run test:desktop:agent（前置desktop:build，完整回归第19入口），仅shared-terminal-agent-ui-中文-自建根/合成会话。agent_management_request只提供Desktop管理白名单，原生独立回复剥离token，不向WebView提供Agent Acquire/Release。通道通过不代表授权GUI或真实桥交付；接管后ACTIVE仍须核对effective_scopes，原编号恢复不续期，服务重启清空回执，审计512环不等于持久全量。

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

- 2026-11-07 用户指定全应用 UI、视效和布局贯穿 Apple Mac 风格与理念，按 [CR-004](docs/changes/CR-004.md) 和 UI_GUIDELINES 落实：内容优先、清晰层级、克制材质与动效、统一排版及控件；保留 Xshell 熟悉结构和 Windows 操作语义。所有页面/弹窗复用现有 tokens/Panel/Field，不能只美化首页；T22/T23 追加全局一致性验证。规则归档不代表现有 UI 已达标。

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


P12共享设计入口tokens.css/style.css，terminalAppearance从CSS读取终端主题/字体，Panel/Field优先复用；禁止面板另写色板/字体。新增npm run test:desktop:appearance（前置desktop:build，完整回归第15入口），仅shared-terminal-appearance-ui-中文-自建根。深浅/系统主题、原生Tab焦点、统一字体字号/来源不变/重载默认及CSS viewport探测不等于T22/T23真实分辨率/DPI/全局矩阵；本窗口偏好仍待受管理持久化，不能从首步宣称P12/G1完成。


P12导航新增npm run test:desktop:navigation（前置desktop:build及已有gui_ssh_fixture），纳入完整桌面回归第16入口。仅shared-terminal-navigation-ui-中文-自建根/合成SSH夹具与合成会话，验证配置选中/独立实例、标签排序/溢出/关闭/隐藏重开、退出确认、后台保留输出和reload身份。主窗口onCloseRequested放行需要既有main的allow-destroy，仍停止服务；隐藏标签不forget/不扩大保留容量。原生默认窗口面积与CSS探测不能替代真实DPI/全局矩阵。


P12基础撰写新增npm run test:desktop:compose（前置desktop:build，自建gui_ssh_fixture），纳入完整回归第17入口；只shared-terminal-compose-ui-中文-自建根/实际合成SSH服务。双实例草稿、精确换行/一次性确认、键盘接管/切换与真实write_text应答丢失命中/不重试、重开与reload清空均须实测；串口专项另验证共享输入队列的精确文本/CRLF，不当COM验收。草稿仅窗口内64份，不持久化正文/同意；预览须等终端实际绑定完整ConnectionRef，发送前再核对。


P12偏好按ADR-042使用配置schema3/单例及Desktop专用preferences/save_preferences，迁移前备份、schema2备份只读默认；备份摘要/事务恢复含偏好，便携配置排除。新增npm run test:desktop:preferences（前置desktop:build，完整回归第18入口），只shared-terminal-preferences-ui-中文-根，实际WebView保存/重载/服务重启/目录隔离、键盘/系统复制/右键精确合成字节、旧revision与真实fetch丢应答命中/不重试。字体/习惯保存不代表草稿/正文/同意或P17工作区已持久化，仍不等于全局DPI/实机/跨版本恢复验收。

P12终端配色按ADR-043升级schema 4，跟随应用/黑底绿字/黑底白字仅共享tokens，禁止JS私有色板。schema 3只读旧偏好补follow_theme且严格拒绝缺失/重复/未知旧字段，schema 4与IPC配色必填；迁移前备份/失败回滚/镜像摘要/安全副本须覆盖。原生preferences/archives扩展方案与备份预览，默认截图不替代真实DPI/输入法矩阵。


P19活动连接常用命令按ADR-066使用schema7受管理模板库；变量值/草稿/发送同意不持久化，准备前重读revision并核对服务/窗格/代次/草稿版本，准备后仍经原撰写预览确认。新增test:desktop:quick-commands为完整第29入口，前置实际desktop:build，仅shared-terminal-quick-commands-ui-中文-自建根/合成SSH/内存串口，finally实际恢复普通服务。完整P19依赖P18的多目标及历史/节奏仍开放，不从此包推导通过；旧schema6程序不能读写新库，备份恢复内容不降版本。


P18显式文本批次按ADR-067独立更多工具入口，默认无目标/正文/确认，2–8个精确SSH2/SERIAL代次按勾选顺序冻结，明确Desktop人工接管后沿原服务FIFO/独立编号；未知停未开始，只查原编号不重放，取消/关闭不撤回已派发。新增test:desktop:broadcast第30入口，前置实际desktop:build，只shared-terminal-broadcast-ui-中文-自建根/合成SSH/内存串口，finally实际恢复普通服务。schema7保持，不授Agent广播，不继承活动窗格/模板同意；连续键盘同步、完整R07/SSH1/实机仍开放。


P19选区发送按ADR-068复用原ComposePanel与统一队列，冻结完整源/revision/精确代次/选区/末尾，范围及Unicode边界严格；无选区不发全文，改选区/正文/末尾/切目标撤同意。队列拒绝保留源，入队后仅移除确认选区、晚回调不覆盖新草稿，后续未知不回填/重放。新增test:desktop:compose-selection第31入口，前置实际desktop:build，仅shared-terminal-compose-selection-ui-中文-自建根/合成SSH/内存UART，finally实际恢复普通服务；全文/常用命令按影响复验，完整历史/节奏/R09/实机仍开放。


P19常用命令选定连接按ADR-069只准备owner/text/ending/origin到原多目标窗口，64KiB共同预算/同源revision和服务复核；不带目标/代次/同意，不动单目标草稿。接收方owner白名单、默认无目标/独立原预览确认，关闭清seed、普通重开和reload不复活。新增test:desktop:command-targets第32入口，前置实际desktop:build，仅shared-terminal-command-targets-ui-中文-自建根/合成SSH/内存UART，finally实际普通恢复。无schema/权限变化，完整历史/节奏/实机等仍开放，不扩连续键盘或触发器。


P19本窗口撰写入队历史按ADR-070默认不记录，主动开启只在窗口内保留手动Compose实际入队片段；32条/256KiB预算、满退最早、单条过大不影响发送。无源目标/授权/完整未选源，不采集认证/键盘/输出/广播；选择只看、明确准备当前草稿后仍原预览确认，已有草稿替换默认不勾。取消勾选/服务变化或失效/reload清空并停止，关闭面板保留本窗口记录，入队不当服务/远端接受。新增test:desktop:compose-history第33入口，前置实际desktop:build，仅shared-terminal-compose-history-ui-中文-自建根/合成SSH/内存UART，finally实际普通恢复。切目标测试须核对data-rendered-id/完整代次及就绪，不以泛化“输入可用”当精确绑定；schema7不变，节奏/持久历史/完整验收仍开放。


2026-11-09现场SSH补录按CR-010/ADR-071优先P12.1修复，S3新增暂缓。等待密码/密钥明确聚焦，表单Enter回答同挑战；有效保存材料每次意图最多自动一次，拒绝后人工补录，不借同名/地址Profile。已保存配置本次记住默认不勾，原保护通道同ID更新/保存不明只读核对不自动认证；当前Actor固定旧Profile故用本次输入，未来Start/重连解析新引用。统一latestStatus完整ref/挑战与同步提交门，不明查询不重放。test:desktop:auth-recovery第34入口前置实际desktop:build，只自建中文根/合成SSH及自建保护记录故障；真实用户根只读安全元数据，不解密/打印/导出秘密，不关既有会话或真实错误登录。

2026-11-09用户CR-011优先会话树空层级/右键精确编辑删除。现场test空、5个根配置只读确认，不自动搬动/合并。编辑复用ConfigPanel与keep保护引用，删除明确目标且不关闭活跃连接/不删日志或共享保护记录；不明只读核对。第35入口test:desktop:tree-actions前置实际构建，仅中文自建根/合成SSH，普通服务无串口feature；真实COM仍无设备待验。

2026-11-09 CR-012优先SSH快速输入/删除延迟，按ADR-072只合并同身份同epoch未发键盘尾项（4KiB/原16项），控制/Compose/粘贴/resize边界保留。回执先查后有界退避、单在途输出交互16ms后回100ms；未知停原窗格无重试。第36入口test:desktop:input-latency前置实际构建，中文自建根/合成SSH，DOM捕获代理和主线程样本不得冒充真实业务/整机CPU。

2026-11-09 CR-013按用户反馈统一移除共享Dialog背景点击关闭，避免输入框内按外放丢草稿；显式按钮/Esc、焦点恢复、标签无确认关闭和未知取消保持，不加普通确认或秘密持久化。第37入口test:desktop:dialog-drag前置实际构建，仅中文自建根/内存库存，无真实端口/服务器，finally实际恢复普通服务。
