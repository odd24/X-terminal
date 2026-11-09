import type {Auth,Profile} from './config-api';
export type LoginSecret={password:string;key:string;passphrase:string;saved?:boolean};
export function chooseLoginSecret(profile:Profile|undefined,auth:Auth,values:{password:string;key:string;passphrase:string}):LoginSecret|undefined{
 if(auth==='keyboard_interactive')return;
 if(auth==='password'&&values.password!==''||auth==='public_key'&&values.key.trim()!=='')return {...values};
 if(profile?.credential_ref&&!profile.credential_missing)return {password:'',key:'',passphrase:'',saved:true};
}
export function credentialHint(profile:Profile|undefined){if(!profile)return '本次登录信息仅用于本次连接；保存凭据需要明确勾选。';if(!profile.credential_ref)return '此配置未记住凭据。登录成功不等于保存密码；请在此输入，勾选记住后才保存。';if(profile.credential_missing)return '此配置的凭据引用已缺失，请重新输入；明确勾选记住可更新该配置。';return '此配置关联了Windows保护凭据；自动登录最多尝试一次，无法读取或被拒绝时请在此补录。';}
export function waitingCredentialText(auth:Auth,rejected:boolean){return `${rejected?'上次登录信息未被服务器接受，':''}等待输入${auth==='public_key'?'私钥文件和口令':'密码'}；可直接输入并按回车提交，无需取消连接。`;}
