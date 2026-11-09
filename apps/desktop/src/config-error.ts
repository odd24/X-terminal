export const messages: Record<string,string> = {
  IN_USE:'凭据仍被当前配置或受管理备份引用，未删除。请先移除引用或保留凭据。',
  CAPACITY:'备份或恢复目录数量达到上限，请先整理副本。',
  INVALID:'配置无效，或目录仍被引用。请检查参数和目录关系。',
  NOT_FOUND:'配置已不存在，请刷新。', CONFLICT:'配置已变化，请刷新后重试。',
  LOCKED:'本服务启动时未取得配置目录的独占访问权，当前占用需要重新检查；这不是串口占用结果。可在连接窗口重新检查配置目录。',
  UNSUPPORTED_SCHEMA:'数据库版本不受支持，未覆盖文件。请使用匹配版本或备份，并重新启动。',
  CORRUPT:'配置或凭据库损坏，未重建文件。请保留原文件并使用备份恢复后重新启动。',
  STORAGE:'配置存储不可用。请检查目录权限和磁盘空间。',
  CREDENTIAL_UNAVAILABLE:'保存的凭据不可用。请重新输入或移除该配置的引用。',
  CONFIG_CHANNEL_UNAVAILABLE:'配置通道不可用，未自动重试。请重新启动桌面。',
  INVALID_CONFIGURATION:'配置参数无效，请检查输入。',
  INVALID_CONFIGURATION_REPLY:'配置响应无法核对，请重新读取；没有自动重试。',
  CapacityExceeded:'配置队列已满，此次操作未被接受。',
};

// Only fixed local messages may cross into UI. Raw exceptions may contain secrets.
export class ConfigRequestError extends Error {
  readonly code:string;
  readonly uncertain:boolean;
  constructor(rawCode:unknown, uncertain=false) {
    const code=typeof rawCode==='string'&&Object.hasOwn(messages,rawCode)?rawCode:'UNKNOWN';
    super(code==='UNKNOWN'?'配置请求未获有效结果；没有自动重试。':messages[code]);
    this.name='ConfigRequestError';this.code=code;this.uncertain=uncertain||['UNKNOWN','STORAGE','CONFIG_CHANNEL_UNAVAILABLE','INVALID_CONFIGURATION_REPLY'].includes(code);
  }
}
