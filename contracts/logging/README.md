# 终端日志格式 v1（P11.3）

P11.4启停阶段已将terminal-log接入统一服务和桌面，历史读取/导出仍在继续。默认不记录，调用者需明确授权连接代次；不包含凭据、自动化输入或操作审计的自动捕获逻辑。所有示例/测试均为合成数据。

现有本地根目录下创建新随机log_id目录；一个段为`0000000000000001.rawlog`和`0000000000000001.text.jsonl`。段号单调增加，至少16位十进制。两文件合计受segment_bytes限制（含头部），最多segments对；默认100MiB×5，可选128KiB–100MiB、1–16段。轮转退休旧段，不自动扩容。额外completion.json小于1KiB，根目录下其他日志不由本引擎自动清理。

## 原始容器

文件头8字节ASCII `STRAW001`，后跟u32 little-endian头部JSON长度及UTF-8 SegmentHeader，头长1–4096。严格serde拒绝未知字段，包含format_version=1、log_id、segment、初始Metadata、Limits和本段source_cursor/text_cursor。Metadata含精确ConnectionRef、协议、编码（utf-8/gbk/gb18030）、started_at_ms、初始raw/text游标；时间为Unix毫秒。段游标不可小于最初游标。中途开始不补写前缀，不代表完整连接。

其后每条为u32 little-endian主体长度（33–4129）和主体：

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0 | 1 | kind：1数据、2源缺口、3解码器最终flush |
| 1 | 8 | text_seq，u64 little-endian |
| 9 | 8 | source_seq，u64 little-endian；kind=3为0表示null |
| 17 | 8 | timestamp_ms，u64 little-endian |
| 25 | 8 | gap_bytes，u64 little-endian；数据/flush为0 |
| 33 | 0–4096 | 原始payload，不变更00/FF/CR/LF，不插入时间戳或换行 |

数据必须有1–4096字节和非零连续source_seq；缺口必须payload为空、gap_bytes>0；flush两者为空，不增加原始游标。text_seq独立连续，source/text游标不能互换。最终文本残留和decode_error只在文本对中表达，不造原字节。kind=3后不允许更多记录。

RawReader先限额再分配内存，逐帧返回，不把整个日志读入内存。帧边界EOF与部分前缀/部分主体区别处理；任一错误使该reader永久失败，不可忽略错误后继续称完整。原始容器不是纯.bin：导出纯字节时必须提取payload，并携带缺口/退休/范围信息。没有CRC或签名，不承诺检测所有内容篡改；后续导出/压力应额外核对范围、序号与校验值。

## 文本与完成

文本第一行为`{"type":"header","header":SegmentHeader}`；其后每行为`{"type":"output","event":TextEvent}`。TextEvent沿用服务字段seq/source_seq/timestamp_ms/text/decode_error/gap_bytes，文本保留ANSI控制内容，尚非screen纯文字。CR/LF/控制字符由JSON转义，记录分隔LF不是终端payload。text最多16KiB，32排队+1在途，提交时去除过量capacity，最坏JSON转义仍适合最小段预算。

服务输出最终flush或手动停止均先排空已接受队列，双文件sync_all后才以create_new写completion.partial并sync_all，关闭临时文件后用Windows MoveFileW不覆盖地发布为completion.json。标志含log_id/ConnectionRef、written_records/bytes、首/末保留段、source_gap_bytes和natural_end。natural_end指服务最终flush，包含FAILED收尾，不表示正常退出；手动停止natural_end=false，不编造远程退出码；失败可能留下completion.partial，不能当作成功；已有目标拒绝覆盖。完成只覆盖该记录窗口的保留部分，退休段和捕获前后都不包含在完整性承诺中。

状态accepted表示排队，written表示两个文件的write_all均成功（仍可能在OS缓存），durable须同步与完成标志成功；失败可能留下部分原始帧或JSON行。发生故障时range为最后成功写入的范围，需重新验证实际文件，不可用written推断物理接受量或当前保留总数。恢复/读取须检查完成标志身份、段范围、双文件/序号及截断，不能单凭一个文件干净EOF声称完成。服务捕获/启停已接入；持久历史、只读导出与恢复检查由P11.4/P24继续实现。

P11.4的PairReader在不可变单段上同时读取raw/text：两份SegmentHeader必须完全相同，逐条核对seq/source_seq/timestamp_ms/gap_bytes，拒绝错误缺口文本、缺少伙伴、未知字段或额外行。JSONL要求每行以LF结尾；头行上限4224字节，输出行上限98816字节，反转义后text仍最多16384字节。超限在继续增长前拒绝，任一错误永久锁定reader；它不验证文件目录政策、完成标志、总文件大小或跨段范围，也不重新解码校对文本内容，不能充当签名/篡改检测或完整连接保证。后续历史读取/导出须在此基础上增加文件和跨段检查。

## 已完成日志的受限文件读取（P11.4）

ArchiveReader仅从ManagedRoot中的随机log_id子目录按精确ConnectionRef打开completion.json及其保留段。完成标志不超过1024字节，段范围最多16，固定目录文件集合必须完整且没有额外项；文件长度合计遵守每段限额。Windows逐级目录及全部文件保持不可写/不可删除共享句柄，拒绝reparse；所有段消费后仍持有句柄到reader关闭。此实现面向Windows；非Windows不提供同等强度的外部并发写入隔离保证。

打开只核对文件策略/身份/头，ArchiveInfo中的completion是磁盘声明；须继续读完并观察最终ArchivePage.finished才表示保留范围全部结构校验通过。每页1–128条、32–256KiB逻辑内容（另一个有界预读记录），next_cursor只跨过已交付记录；使用阻塞文件I/O，服务调用方必须放在有界文件工作线程，另行管理读句柄总额/生命周期。跨段来源/文本序号、EOF、总记录和保留字节/缺口下界（无退休时精确量）与完成标志核对，失败永久锁定。没有签名/CRC，不承诺检测成对一致篡改；不复原已退休数据或从中间开始前缺失的字符。

较早v1完成标志没有source_gap_bytes时返回未知而非0，当前写入仍总是包含该字段。累计源缺口溢出现在在接受前报CounterExhausted并拒绝发布完成标志。无完成标志或partial日志尚不能用本reader读取，故障前缀恢复/P24继续；历史IPC/浏览/搜索/导出仍在P11.4实施。

P11.4已将目录/受限读取接入Desktop专用IPC，默认不读取/导出；actor配额、页重试/过期、目录状态和配置损坏读取策略见[IPC说明](../ipc/README.md)及ADR-030。仍缺历史浏览/搜索/导出UI、未完成文件恢复与持久容量整理。

P11.4桌面已可显式刷新/选择历史日志，分页浏览原始HEX和转义派生文本，按保留范围流式字面搜索。时间显示北京时间，不改持久字段。列表最多100条摘录，但继续全文扫描/统计，源缺口隔断匹配，取消/错误保持未全检。历史目标不跟随活动连接；导出、损坏前缀恢复与容量整理仍在实施。

## 可移植JSONL导出流v1（文件库阶段）

export_jsonl新开精确作用域的ArchiveReader，逐32KiB逻辑页完整扫描保留范围，不采用调用方已前进的分页游标。每行独立JSON，LF分隔；头type=header，format=shared-terminal-export、format_version=1，含metadata、source_completion、limits、available_from和source_available_from。中间type=record，raw为完整OutputEvent（bytes为0–255整数数组）或flush时null，text为独立TextEvent；控制内容仅JSON数据，不执行。末行type=verified，retained含retained_records/retained_raw_bytes/retained_gap_bytes/next_cursor，仅在所有段和最终声明校验后写入。

source_completion为原文件声明，退休历史无法全检，不以其总量冒充导出保留量。旧source_gap_bytes缺失仍缺失；时间保留epoch毫秒，source gap不补造字节。无签名/防篡改承诺。此库API没有路径/IPC/保存入口，接收调用者Write；调用者须在阻塞线程执行、授权精确目标、使用私有新暂存，只有Ok并sync后才不覆盖发布。取消、源损坏、写/flush失败均不得发布；flush失败可能已经写出尾行，不能仅靠尾行声称持久保存。后续服务/桌面保存、失败恢复和容量整理继续。

ExportStore提供文件库层的受管理暂存：可信服务数据目录/terminal-log-exports，Windows独占exports.lock；最多8个UUID尝试目录，含失败不自动删除，未知项/目录reparse拒绝。单份实际JSON编码上限256MiB，超限返回FileTooLarge而非截断成功。固定export.partial使用create_new独占写；全检/flush/sync_all与取消检查后，以MoveFileW不覆盖发布export.jsonl。ExportArtifact仅含ID、字节数及实际保留统计；原始日志不修改。失败/取消/已有目标时不发布、不自动重试；partial即使有verified也不等同成功产物。尚无IPC/用户保存入口/任务回执和显式清理，不能从文件名推断授权。

服务现已新增Desktop专用export_start/status/cancel任务，参见[IPC说明](../ipc/README.md)。独立文件线程1在途/8队列、64本次服务回执，状态/取消不等待文件I/O；成功发布与取消冲突以发布成功为准，不编造撤销。此入口只在受管理目录准备产物，不接收任意路径、不代表用户已保存到自选位置；桌面按钮/保存与显式容量整理继续。

桌面历史工具现有导出按钮、状态/取消和受管理文件完整路径（可选中复制），固定任务目标独立于活动连接/历史选择。成功路径只在精确作用域及终态计数校验后显示；请求错误保持原ID，仅查询而不自动Start。sessionStorage单槽只存作用域，重载后主动查询；NotFound明确本次服务无回执，可显式新建新ID，不覆盖旧目录。关闭面板只请求停止未完成导出，可能已发布，不撤销文件；终端捕获不停止。自选另存位置/打开目录和显式容量整理尚未实施。
