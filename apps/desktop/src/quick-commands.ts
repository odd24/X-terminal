import type {QuickCommand} from './config-api';
import type {ComposeTarget,Ending} from './compose-drafts';
export type QuickContext={owner:string;pane:string;epoch:number;target:ComposeTarget;draftVersion:number};
export function sameQuickContext(a:QuickContext|undefined,b:QuickContext|undefined){return !!a&&!!b&&a.owner===b.owner&&a.pane===b.pane&&a.epoch===b.epoch&&a.draftVersion===b.draftVersion&&a.target.connection_id===b.target.connection_id&&a.target.generation===b.target.generation&&a.target.protocol===b.target.protocol;}
const pattern=()=>/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/gu;
export function commandVariables(template:string){const names=[...new Set(Array.from(template.matchAll(pattern()),m=>m[1]))];if(names.length>16)throw new Error('每条命令最多16个变量。');return names;}
export function validateQuickCommand(command:QuickCommand){for(const value of [command.name,command.group])if(!value||value.trim()!==value||value.length>64||/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\uD800-\uDFFF]/u.test(value))throw new Error('名称和分组需为1–64个字符，不能含首尾空白或控制字符。');if(!command.template||command.template.length>8192||/[\uD800-\uDFFF]/u.test(command.template))throw new Error('模板需为1–8192个完整Unicode单元。');if(!['none','cr','lf','crlf'].includes(command.ending))throw new Error('末尾换行无效。');commandVariables(command.template);}
const endings:Record<Ending,string>={none:'',cr:'\r',lf:'\n',crlf:'\r\n'};
export function prepareQuickCommand(command:QuickCommand,values:Record<string,string>,protocol:string){
 validateQuickCommand(command);if(!['SSH2','SERIAL','FIXTURE'].includes(protocol))throw new Error('当前协议尚不支持准备文本。');
 for(const name of commandVariables(command.template))if(!Object.hasOwn(values,name)||typeof values[name]!=='string'||values[name].length===0||values[name].length>8192||/[\uD800-\uDFFF]/u.test(values[name]))throw new Error('请完整填写全部变量，每项最多8192个字符。');
 const text=command.template.replace(pattern(),(_whole,name:string)=>values[name]);const payload=text+endings[command.ending];
 if(text.length>65536||new TextEncoder().encode(payload).length>(protocol==='SSH2'?196608:65536))throw new Error('替换后的内容超过当前连接单批上限，请缩短变量或模板。');return {text,ending:command.ending};
}

export function prepareCommandBatch(command:QuickCommand,values:Record<string,string>,owner:string){
 if(!owner)throw new Error('会话服务尚未就绪，未准备。');const resolved=prepareQuickCommand(command,values,'SERIAL');return Object.freeze({owner,text:resolved.text,ending:resolved.ending,origin:command.name});
}
