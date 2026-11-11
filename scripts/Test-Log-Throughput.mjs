import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {lstat,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {launchDesktop} from './lib/DesktopHarness.mjs';

const args=process.argv.slice(2);
assert.ok(args.every(v=>v==='--calibrate'||v==='--d-tmp'),'unknown throughput option');
const calibration=args.includes('--calibrate'),candidate=args.includes('--d-tmp');
assert.ok(!candidate||(calibration&&args.length===2),'D candidate is limited to one fixed short calibration');
const build=args=>{const result=spawnSync('cargo',args,{windowsHide:true,stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0,'measurement build/ordinary restoration must actually succeed');};
const binaries=['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe'];
const hashes=async()=>Object.fromEntries(await Promise.all(binaries.map(async name=>[name,createHash('sha256').update(await readFile(path.resolve('target/debug',name))).digest('hex')])));
const before=await hashes(),startedAt=new Date().toISOString();
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
build(['build','-p','session-service','--example','log_throughput','--locked']);
const executable=path.resolve('target/debug/examples/log_throughput.exe');
const candidatePath=id=>path.win32.join('D:\\tmp',`P22-throughput-中文-${id}`);
const run=async args=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,stdio:'inherit'});
  child.on('error',reject);child.on('exit',(code,signal)=>signal?reject(new Error(`measurement exited by signal ${signal}`)):resolve(code));
});
const id=candidate?randomUUID():null;
const root=candidate?candidatePath(id):await mkdtemp(path.resolve('artifacts/P22-throughput-中文-'));
const evidence=candidate?path.resolve(`artifacts/P22-throughput-d-tmp-${id}`):null;
console.log(`MEASUREMENT_ROOT ${root}`);
let resultCode,ordinary=false;
let candidateAvailableMemory;
try {
  if(candidate){
    const guardRoot=candidatePath(randomUUID());
    assert.equal(await run([guardRoot,'32','1','--check-d-tmp-root']),0);
    await assert.rejects(lstat(guardRoot),{code:'ENOENT'});
    candidateAvailableMemory=os.freemem();
  }
  resultCode=await run([root,calibration?'32':'1800',calibration?'1':'100',...(candidate?['--d-tmp-calibrate']:[])]);
} finally {
  build(['build','-p','session-service','--locked']);
  const probe=await mkdtemp(path.resolve('artifacts/P22-throughput-ordinary-中文-'));let ui;
  try {
    if(candidate){
      assert.equal(await run([probe,'32','1','--probe-ordinary']),0);
      const report=JSON.parse(await readFile(path.join(probe,'result.json'),'utf8'));
      assert.equal(report.ordinary_runtime_fixture_denied,true);
      assert.equal(report.owned_service_clean_exit,true);
    }else{
      ui=await launchDesktop(probe);assert.equal((await ui.invoke('service_status')).fixture,false);
      assert.deepEqual(await ui.invoke('service_list'),[]);
      assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>false,error=>error==='FIXTURE_DISABLED')`),true);
    }
    ordinary=true;
  } finally {
    await ui?.close();const target=path.resolve(probe);assert.equal(path.dirname(target),path.resolve('artifacts'));assert.ok(path.basename(target).startsWith('P22-throughput-ordinary-中文-'));
    await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
  await writeFile(candidate?`${evidence}-environment.json`:path.join(root,'environment.json'),JSON.stringify({source,calibration,startedAt,finishedAt:new Date().toISOString(),
    ...(candidate?{candidate_root:root,available_memory_before_measurement:candidateAvailableMemory,ordinary_probe:'headless Named Pipe'}:{}),
    platform:os.platform(),os_release:os.release(),arch:os.arch(),logical_cpus:os.cpus().length,cpu_model:os.cpus()[0].model,total_memory:os.totalmem(),
    before,after:await hashes(),ordinary_build_restored:true,ordinary_runtime_fixture_denied:ordinary,measurement_exit_code:resultCode},null,2)+'\n');
}
assert.equal(resultCode,0,`actual measurement failed; preserve ${root}`);
if(candidate)await assert.rejects(lstat(root),{code:'ENOENT'});
const report=JSON.parse(await readFile(candidate?`${evidence}.json`:path.join(root,'result.json'),'utf8'));
assert.equal(report.passed,true);assert.equal(report.owned_service_clean_exit,true);
console.log(`PASS ${calibration?'short calibration':'formal 30 minute'}: exact whole-run verification, source and retained/retired counters; ${root}`);
