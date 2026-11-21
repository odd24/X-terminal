export type LogViewer = { executable: string|null; available: boolean };

const openSettings='请在主窗口的「软件设置 → 日志」改选应用或恢复 Windows 系统默认。';
const failures:Record<string,string>={
  LOG_VIEWER_MISSING:'所选日志打开程序不存在或不可访问。'+openSettings,
  LOG_VIEWER_INVALID:'请选择本地磁盘上可读取的 .exe 程序。'+openSettings,
  LOG_VIEWER_LAUNCH:'Windows 未能启动所选程序。'+openSettings,
  LOG_VIEWER_SYSTEM_FAILED:'Windows 未能用默认方式打开日志。'+openSettings,
  LOG_VIEWER_STORAGE:'日志打开方式暂时无法读取或保存。请核对应用数据目录后重试。',
  LOG_VIEWER_PICKER:'Windows 程序选择器暂时不可用，请重试。',
  LOG_VIEWER_CATALOG:'暂时无法读取 Windows 登记的应用。仍可浏览本地程序。',
  LOG_VIEWER_CANDIDATE_CHANGED:'Windows 登记的应用已变化，请在更新后的列表中重新选择。',
  LOG_VIEWER_BUSY:'程序选择器已经打开，请先完成或取消选择。',
  LOG_VIEWER_MAIN_REQUIRED:'请在主窗口的「软件设置 → 日志」修改日志打开方式。',
};
export const logViewerFailure=(code:string)=>failures[code];
