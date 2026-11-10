import test from 'node:test';
import assert from 'node:assert/strict';
import {closeFacts} from '../apps/desktop/src/close-receipt.ts';
test('unknown ACK, observed exit and kill submission remain independent facts',()=>{
  const base={shutdown_ack:'UNKNOWN',exited:true,exit_code:0,kill_requested:false,kill_request_ok:null,reader:{diagnostic:null}};
  assert.match(closeFacts(base).shutdown,/未知；未重发/);assert.match(closeFacts(base).process,/代码 0/);assert.equal(closeFacts(base).audit,'审计关闭信息未知');
  assert.equal(closeFacts({...base,kill_requested:true,kill_request_ok:false}).kill,'已请求强退，请求未成功提交');
  assert.equal(closeFacts({...base,kill_requested:true,kill_request_ok:true}).kill,'已请求强退，请求已提交');
  assert.equal(closeFacts({...base,exited:false,exit_code:null}).process,'尚未观察到本地进程退出');
});
