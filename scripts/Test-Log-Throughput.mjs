import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {lstat,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {launchDesktop} from './lib/DesktopHarness.mjs';

const args=process.argv.slice(2);
assert.ok(args.every(v=>v==='--calibrate'||v==='--d-tmp'||v==='--timeline'),'unknown throughput option');
const calibration=args.includes('--calibrate'),candidate=args.includes('--d-tmp'),timeline=args.includes('--timeline');
assert.ok(!timeline||candidate,'timeline requires the D candidate');
assert.ok(!candidate||(calibration&&args.length===(timeline?3:2)),'D candidate is limited to one fixed short calibration');
const build=args=>{const result=spawnSync('cargo',args,{windowsHide:true,stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0,'measurement build/ordinary restoration must actually succeed');};
const binaries=['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe'];
const hashes=async()=>Object.fromEntries(await Promise.all(binaries.map(async name=>[name,createHash('sha256').update(await readFile(path.resolve('target/debug',name))).digest('hex')])));
const before=await hashes(),startedAt=new Date().toISOString();
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const executable=path.resolve('target/debug/examples/log_throughput.exe');
const service=path.resolve('target/debug/session-service.exe');
const timelineService=path.resolve('target/debug/session-service-t19-timeline.exe');
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
let smokeId;
let ordinaryBeforeMeasurement;
const rejectSwitch=(executable,args,code)=>{
  const result=spawnSync(executable,args,{windowsHide:true,encoding:'utf8',timeout:10000});
  if(result.error)throw result.error;
  assert.equal(result.status,1);
  assert.match(result.stderr,new RegExp(code));
  assert.equal(result.stdout,'');
};
const fixtureArgs=()=>['--instance',randomUUID(),'--test-fixture','--t19-timeline-fixture'];
const rejectOrdinary=()=>rejectSwitch(service,fixtureArgs(),'T19_TIMELINE_FIXTURE_DISABLED');
try {
  if(timeline){
    build(['build','-p','session-service','--bin','session-service-t19-timeline','--example','log_throughput','--features','t19-timeline-fixture','--locked']);
    build(['build','-p','session-service','--bin','session-service','--locked']);
    rejectOrdinary();
    ordinaryBeforeMeasurement=await hashes();
    rejectSwitch(timelineService,['--instance',randomUUID(),'--t19-timeline-fixture'],'T19_TIMELINE_FIXTURE_ARGUMENTS_REJECTED');
    rejectSwitch(timelineService,fixtureArgs(),'T19_TIMELINE_FIXTURE_ROOT_REQUIRED');
    rejectSwitch(timelineService,[...fixtureArgs(),'--data-dir',path.resolve('artifacts')],'T19_TIMELINE_FIXTURE_ROOT_REJECTED');
  }else{
    build(['build','-p','session-service','--example','log_throughput','--locked']);
  }
  if(candidate){
    const guardRoot=candidatePath(randomUUID());
    assert.equal(await run([guardRoot,'32','1','--check-d-tmp-root']),0);
    await assert.rejects(lstat(guardRoot),{code:'ENOENT'});
    if(timeline){
      smokeId=randomUUID();
      const smokeRoot=candidatePath(smokeId);
      assert.equal(await run([smokeRoot,'32','1','--check-timeline']),0);
      await assert.rejects(lstat(smokeRoot),{code:'ENOENT'});
      const smoke=JSON.parse(await readFile(path.resolve(`artifacts/P22-throughput-d-tmp-${smokeId}.json`),'utf8'));
      assert.equal(smoke.timeline.smoke_passed,true);
      assert.equal(smoke.timeline.workers_closed,true);
      console.log(`TIMELINE_SMOKE ${smokeId}`);
    }
    candidateAvailableMemory=os.freemem();
    if(timeline)assert.ok(candidateAvailableMemory>=1536*1024*1024,'available memory below the combined existing service/harness budgets');
  }
  resultCode=await run([root,calibration?'32':'1800',calibration?'1':'100',...(candidate?[timeline?'--d-tmp-timeline':'--d-tmp-calibrate']:[])]);
} finally {
  build(['build','-p','session-service','--locked']);
  if(timeline)rejectOrdinary();
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
    ...(timeline?{timeline_fixture:true,timeline_smoke_id:smokeId,ordinary_timeline_switch_denied:true,ordinary_before_measurement:ordinaryBeforeMeasurement}:{}),
    platform:os.platform(),os_release:os.release(),arch:os.arch(),logical_cpus:os.cpus().length,cpu_model:os.cpus()[0].model,total_memory:os.totalmem(),
    before,after:await hashes(),ordinary_build_restored:true,ordinary_runtime_fixture_denied:ordinary,measurement_exit_code:resultCode},null,2)+'\n');
}
assert.equal(resultCode,0,`actual measurement failed; preserve ${root}`);
if(candidate)await assert.rejects(lstat(root),{code:'ENOENT'});
const report=JSON.parse(await readFile(candidate?`${evidence}.json`:path.join(root,'result.json'),'utf8'));
assert.equal(report.passed,true);assert.equal(report.owned_service_clean_exit,true);
console.log(`PASS ${calibration?'short calibration':'formal 30 minute'}: exact whole-run verification, source and retained/retired counters; ${root}`);
