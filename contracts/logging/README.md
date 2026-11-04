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
