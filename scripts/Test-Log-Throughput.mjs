import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {launchDesktop} from './lib/DesktopHarness.mjs';

assert.ok(process.argv.slice(2).every(v=>v==='--calibrate'),'only explicit --calibrate or fixed 30 minute formal mode');
const calibration=process.argv.includes('--calibrate');
const build=args=>{const result=spawnSync('cargo',args,{windowsHide:true,stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0,'measurement build/ordinary restoration must actually succeed');};
const binaries=['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe'];
const hashes=async()=>Object.fromEntries(await Promise.all(binaries.map(async name=>[name,createHash('sha256').update(await readFile(path.resolve('target/debug',name))).digest('hex')])));
const before=await hashes(),startedAt=new Date().toISOString();
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
build(['build','-p','session-service','--example','log_throughput','--locked']);
const root=await mkdtemp(path.resolve('artifacts/P22-throughput-中文-'));
console.log(`MEASUREMENT_ROOT ${root}`);
let resultCode,ordinary=false;
try {
  resultCode=await new Promise((resolve,reject)=>{
    const child=spawn(path.resolve('target/debug/examples/log_throughput.exe'),[root,calibration?'32':'1800',calibration?'1':'100'],{windowsHide:true,stdio:'inherit'});
    child.on('error',reject);child.on('exit',(code,signal)=>signal?reject(new Error(`measurement exited by signal ${signal}`)):resolve(code));
  });
} finally {
  build(['build','-p','session-service','--locked']);
  const probe=await mkdtemp(path.resolve('artifacts/P22-throughput-ordinary-中文-'));let ui;
  try {
    ui=await launchDesktop(probe);assert.equal((await ui.invoke('service_status')).fixture,false);
    assert.deepEqual(await ui.invoke('service_list'),[]);
    assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>false,error=>error==='FIXTURE_DISABLED')`),true);
    ordinary=true;
  } finally {
    await ui?.close();const target=path.resolve(probe);assert.equal(path.dirname(target),path.resolve('artifacts'));assert.ok(path.basename(target).startsWith('P22-throughput-ordinary-中文-'));
    await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
  await writeFile(path.join(root,'environment.json'),JSON.stringify({source,calibration,startedAt,finishedAt:new Date().toISOString(),
    platform:os.platform(),os_release:os.release(),arch:os.arch(),logical_cpus:os.cpus().length,cpu_model:os.cpus()[0].model,total_memory:os.totalmem(),
    before,after:await hashes(),ordinary_build_restored:true,ordinary_runtime_fixture_denied:ordinary,measurement_exit_code:resultCode},null,2)+'\n');
}
assert.equal(resultCode,0,`actual measurement failed; preserve ${root}`);
const report=JSON.parse(await readFile(path.join(root,'result.json'),'utf8'));
assert.equal(report.passed,true);assert.equal(report.owned_service_clean_exit,true);
console.log(`PASS ${calibration?'short calibration':'formal 30 minute'}: exact whole-run verification, source and retained/retired counters; ${root}`);
