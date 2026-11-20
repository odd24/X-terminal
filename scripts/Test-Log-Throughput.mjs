import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {lstat,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {launchDesktop} from './lib/DesktopHarness.mjs';

const args=process.argv.slice(2);
assert.ok(args.every(v=>['--calibrate','--d-tmp','--c-tmp','--timeline','--compare-sync'].includes(v)),'unknown throughput option');
const systemTemp=args.includes('--c-tmp'),dTemp=args.includes('--d-tmp');
const calibration=systemTemp||args.includes('--calibrate'),candidate=dTemp||systemTemp,timeline=args.includes('--timeline');
const compare=args.includes('--compare-sync');
assert.ok(!systemTemp||args.length===1,'C temporary measurement runs exactly one calibration, then formal only on pass');
assert.ok(!compare||timeline,'sync comparison requires the timeline fixture');
assert.ok(!timeline||dTemp,'timeline requires the D candidate');
assert.ok(!dTemp||(calibration&&args.length===(timeline?3+Number(compare):2)),'D candidate is limited to fixed short calibration');
const build=args=>{const result=spawnSync('cargo',args,{windowsHide:true,stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0,'measurement build/ordinary restoration must actually succeed');};
const binaries=['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe'];
const hashes=async()=>Object.fromEntries(await Promise.all(binaries.map(async name=>[name,createHash('sha256').update(await readFile(path.resolve('target/debug',name))).digest('hex')])));
const before=await hashes(),startedAt=new Date().toISOString();
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
const executable=path.resolve('target/debug/examples/log_throughput.exe');
const service=path.resolve('target/debug/session-service.exe');
const timelineService=path.resolve('target/debug/session-service-t19-timeline.exe');
const candidatePath=id=>path.win32.join(systemTemp?'C:\\Users\\Administrator\\AppData\\Local\\Temp':'D:\\tmp',`P22-throughput-中文-${id}`);
const candidateEvidence=id=>path.resolve(`artifacts/P22-throughput-${systemTemp?'c':'d'}-tmp-${id}`);
const run=async args=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,stdio:'inherit'});
  child.on('error',reject);child.on('exit',(code,signal)=>signal?reject(new Error(`measurement exited by signal ${signal}`)):resolve(code));
});
const id=candidate?randomUUID():null;
const root=candidate?candidatePath(id):await mkdtemp(path.resolve('artifacts/P22-throughput-中文-'));
const evidence=candidate?candidateEvidence(id):null;
console.log(`MEASUREMENT_ROOT ${root}`);
let resultCode,ordinary=false;
let candidateAvailableMemory;
let smokeId;
let ordinaryBeforeMeasurement;
let syncComparison;
const cRun=systemTemp?{ calibration: { id, root }, formal: null }:null;
async function verifyMeasurement(prefix, seconds) {
  const report = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.owned_service_clean_exit, true);
  assert.equal(report.duration_seconds, seconds);
  assert.equal(report.streams, 8);
  const diagnostics = (await readFile(`${prefix}-service-stderr.txt`, 'utf8'))
    .split(/\r?\n/).filter(line => line.startsWith('audit_close_diagnostic '));
  assert.equal(diagnostics.length, 1, 'managed audit close diagnostic');
  const audit = JSON.parse(diagnostics[0].slice('audit_close_diagnostic '.length));
  assert.deepEqual([audit.outcome,audit.state,audit.rejected,audit.incomplete,audit.first_failure],
    ['CLOSED','CLOSED','0',0,null]);
  assert.equal(audit.accepted,audit.synced);
}
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
    if (compare) {
      const concurrentArgs = [...fixtureArgs().slice(0,3),'--t19-concurrent-sync-fixture'];
      rejectSwitch(service, concurrentArgs, 'T19_TIMELINE_FIXTURE_DISABLED');
      rejectSwitch(timelineService, concurrentArgs, 'T19_TIMELINE_FIXTURE_ROOT_REQUIRED');
      rejectSwitch(timelineService, [...concurrentArgs,'--data-dir',path.resolve('artifacts')], 'T19_TIMELINE_FIXTURE_ROOT_REJECTED');
    }
  }else{
    build(['build','-p','session-service','--example','log_throughput','--locked']);
  }
  if(candidate){
    const guardRoot=candidatePath(randomUUID());
    assert.equal(await run([guardRoot,'32','1',systemTemp?'--check-c-tmp-root':'--check-d-tmp-root']),0);
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
    if(timeline||systemTemp)assert.ok(candidateAvailableMemory>=1536*1024*1024,'available memory below the combined existing service/harness budgets');
  }
  resultCode=await run([root,calibration?'32':'1800',calibration?'1':'100',...(candidate?[systemTemp?'--c-tmp-calibrate':timeline?'--d-tmp-timeline':'--d-tmp-calibrate']:[])]);
  if (cRun) {
    cRun.calibration.exitCode = resultCode;
    if (resultCode === 0) {
      await verifyMeasurement(evidence, 32);
      await assert.rejects(lstat(root),{code:'ENOENT'});
      const availableMemory = os.freemem();
      assert.ok(availableMemory>=1536*1024*1024,'available memory below service/harness budgets before formal measurement');
      const formalId=randomUUID(), formalRoot=candidatePath(formalId);
      cRun.formal={id:formalId, root:formalRoot, availableMemory};
      console.log(`PASS C temporary 32-second calibration; FORMAL_ROOT ${formalRoot}`);
      resultCode=await run([formalRoot,'1800','100','--c-tmp-formal']);
      cRun.formal.exitCode=resultCode;
      if(resultCode===0) {
        await verifyMeasurement(candidateEvidence(formalId), 1800);
        await assert.rejects(lstat(formalRoot),{code:'ENOENT'});
      }
    }
  }
  if (compare) {
    const baseline = JSON.parse(await readFile(`${evidence}.json`, 'utf8'));
    assert.equal(baseline.periodic_sync, 'serial');
    syncComparison = { baseline: id, baselineExitCode: resultCode, baselineFirstFault: baseline.timeline?.first_fault?.kind ?? null,
      candidate: null, disposition: 'BASELINE_QUEUE_FULL_NOT_REPRODUCED' };
    if (baseline.owned_service_clean_exit === true && baseline.timeline?.workers_closed === true
        && baseline.timeline.first_fault?.kind === 'queue_full') {
      const memory = os.freemem();
      assert.ok(memory >= 1536*1024*1024, 'memory below service and harness budgets before candidate');
      const pairedId = randomUUID();
      const pairedRoot = candidatePath(pairedId);
      console.log(`CONCURRENT_ROOT ${pairedRoot}`);
      const exitCode = await run([pairedRoot, '32', '1', '--d-tmp-concurrent-sync']);
      const paired = JSON.parse(await readFile(path.resolve(`artifacts/P22-throughput-d-tmp-${pairedId}.json`), 'utf8'));
      assert.equal(paired.periodic_sync, 'concurrent');
      syncComparison.candidate = { id: pairedId, exitCode, passed: paired.passed, firstFault: paired.timeline?.first_fault?.kind ?? null };
      syncComparison.disposition = paired.passed ? 'CANDIDATE_CALIBRATION_PASS' : 'CANDIDATE_CALIBRATION_FAIL';
    }
  }
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
    before,after:await hashes(),ordinary_build_restored:true,ordinary_runtime_fixture_denied:ordinary,measurement_exit_code:resultCode,
    ...(compare?{syncComparison}:{}),...(cRun?{cRun}:{})},null,2)+'\n');
}
assert.equal(resultCode,0,`actual measurement failed; preserve ${cRun?.formal?.root??root}`);
if(candidate)await assert.rejects(lstat(root),{code:'ENOENT'});
const report=JSON.parse(await readFile(candidate?`${evidence}.json`:path.join(root,'result.json'),'utf8'));
assert.equal(report.passed,true);assert.equal(report.owned_service_clean_exit,true);
console.log(`PASS ${systemTemp?'C temporary calibration and formal 30 minute':calibration?'short calibration':'formal 30 minute'}: exact whole-run verification, source and retained/retired counters; ${cRun?.formal?.root??root}`);
