import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {launchDesktop} from './lib/DesktopHarness.mjs';

const startedAt=new Date().toISOString();
const binaries=['shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe'];
const hashes=async()=>Object.fromEntries(await Promise.all(binaries.map(async name=>[name,createHash('sha256').update(await readFile(path.resolve('target/debug',name))).digest('hex')])));
const before=await hashes();
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
for(const flags of [['--security'],['--security','--serial']]){
  const result=spawnSync(process.execPath,['scripts/Test-Desktop-Mcp.mjs',...flags],{windowsHide:true,stdio:'inherit'});
  if(result.error)throw result.error;
  assert.equal(result.status,0,'each real stdio run, owned cleanup and memory-fixture ordinary build restoration must succeed');
}
// The serial run's finally built the ordinary executable; now verify its normal runtime too.
const directory=await mkdtemp(path.join(tmpdir(),'shared-terminal-security-ordinary-中文-'));
let ui;
try {
  ui=await launchDesktop(directory);
  assert.equal((await ui.invoke('service_status')).fixture,false);
  assert.deepEqual(await ui.invoke('service_list'),[]);
  assert.equal(await ui.evaluate(`window.__TAURI_INTERNALS__.invoke('fixture_create').then(()=>false,error=>error==='FIXTURE_DISABLED')`),true);
} finally {
  await ui?.close();const target=path.resolve(directory);
  assert.equal(path.dirname(target),path.resolve(tmpdir()));assert.ok(path.basename(target).startsWith('shared-terminal-security-ordinary-中文-'));
  await rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
const reports=await Promise.all(['ssh','serial'].map(async kind=>JSON.parse(await readFile(`artifacts/P22-security-v6-${kind}.json`,'utf8'))));
assert.ok(reports.every(report=>report.checks.model_run===false&&report.stdio_exit===0&&report.service_loss==='UNKNOWN_DELIVERY'));
const after=await hashes();
assert.equal(after['shared-terminal-desktop.exe'],before['shared-terminal-desktop.exe']);
assert.equal(after['terminal-mcp.exe'],before['terminal-mcp.exe']);
await writeFile('artifacts/P22-security-v6-result.json',JSON.stringify({source,startedAt,finishedAt:new Date().toISOString(),before,after,
  results:reports.map(r=>({transport:r.transport,tools:r.tools.length,denials:r.denials.length,checks:r.checks})),
  ordinary_service_build_restored:true,ordinary_runtime_fixture_denied:true,owned_processes_closed:true,model_run:false},null,2)+'\n');
console.log('PASS P22/T17 bounded deterministic SSH2+memory UART stdio isolation; ordinary service restored and normal runtime rejects fixtures; no model run or real-device claim');
