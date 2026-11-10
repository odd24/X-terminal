export type AuditClose = {version:number;outcome:string;state:string|null;accepted:string|null;synced:string|null;rejected:string|null;incomplete:number|null;first_failure:{kind:string;stage:string}|null};
export type CloseReceipt = {version:number;service_id:string;owned_pid:number;started_at_ms:string;recorded_at_ms:string;shutdown_attempted:boolean;shutdown_ack:'NOT_ATTEMPTED'|'ACKNOWLEDGED'|'UNKNOWN';request_error:string|null;exited:boolean;exit_code:number|null;wait_error:string|null;kill_requested:boolean;kill_request_ok:boolean|null;reader:{join:string;eof:boolean;io_failed:boolean;candidates:number;valid:number;invalid:number;unsupported:number;oversized:number;ignored:number;partial:boolean;diagnostic:AuditClose|null}};
export type PreviousClose = {availability:'READY'|'EMPTY'|'BUSY'|'UNTRUSTED'|'UNSUPPORTED'|'CAPACITY'|'UNAVAILABLE'|'TIMEOUT';receipt:CloseReceipt|null;attention:boolean};
export function closeFacts(r:CloseReceipt){
  return {
    shutdown:r.shutdown_ack==='ACKNOWLEDGED'?'已收到关闭确认':r.shutdown_ack==='NOT_ATTEMPTED'?'未尝试发送关闭请求':'关闭确认未知；未重发请求',
    process:r.exited?(r.exit_code===null?'已观察到本地进程退出，退出码未知':`已观察到本地进程退出，代码 ${r.exit_code}`):'尚未观察到本地进程退出',
    kill:!r.kill_requested?'未请求强退':r.kill_request_ok===true?'已请求强退，请求已提交':r.kill_request_ok===false?'已请求强退，请求未成功提交':'已请求强退，请求结果未知',
    audit:!r.reader.diagnostic?'审计关闭信息未知':r.reader.diagnostic.outcome==='CLOSED'?'已收到审计关闭快照':'审计关闭未完整确认',
  };
}
export const availabilityText:Record<PreviousClose['availability'],string>={READY:'已取得本次启动前的可用关闭记录。',EMPTY:'暂无本次启动前的可用关闭记录。',BUSY:'关闭记录暂时不可用。',UNTRUSTED:'关闭记录不可用；现有文件保持原状。',UNSUPPORTED:'关闭记录版本暂不支持；现有文件保持原状。',CAPACITY:'关闭记录暂不可用；已达到受管理范围。',UNAVAILABLE:'关闭记录暂不可用。',TIMEOUT:'关闭记录读取结果尚未确认。'};
