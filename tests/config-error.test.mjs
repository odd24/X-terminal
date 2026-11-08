import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigRequestError } from '../apps/desktop/src/config-error.ts';

test('business rejection retains a safe typed cause distinct from ambiguous delivery',()=>{
 const locked=new ConfigRequestError('LOCKED');
 assert.equal(locked.code,'LOCKED');assert.equal(locked.uncertain,false);assert.match(locked.message,/另一服务.*保存旧窗口.*重新启动/);
 const invalid=new ConfigRequestError('INVALID');assert.equal(invalid.uncertain,false);
 for(const code of ['STORAGE','CONFIG_CHANNEL_UNAVAILABLE','INVALID_CONFIGURATION_REPLY'])assert.equal(new ConfigRequestError(code).uncertain,true);
 assert.equal(new ConfigRequestError('INVALID',true).uncertain,true,'a lost response cannot be downgraded to rejection');
});

test('unknown exceptions and prototype names never become UI messages or error codes',()=>{
 for(const raw of ['synthetic-secret-path-and-password','constructor','__proto__',new Error('synthetic-secret'),{toString(){throw new Error('must not inspect raw objects');}}]){
  const error=new ConfigRequestError(raw);assert.equal(error.code,'UNKNOWN');assert.equal(error.uncertain,true);assert.doesNotMatch(error.message,/synthetic|constructor|__proto__/);
 }
});
