import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const ordinary=process.argv.includes('--ordinary'),base=path.resolve(ordinary?'target/debug':'target/serial-mcp-fixture');
const roots=[];let passed=false,count=0;
try{
 for(const badPrefix of ordinary?[false]:[false,true]){
  const root=await mkdtemp(path.join(tmpdir(),badPrefix?'shared-terminal-mcp-guard-reject-中文-':'shared-terminal-mcp-serial-control-中文-guard-'));roots.push(root);
  for(const native of [false,true]){
   const args=[...(!native?['--instance','fixture-guard']:[]),...(ordinary||badPrefix?['--test-fixture']:[]),'--serial-mcp-fixture','--data-dir',root];
   const probe=spawnSync(path.join(base,native?'shared-terminal-desktop.exe':'session-service.exe'),args,{windowsHide:true,encoding:'utf8',timeout:10000,maxBuffer:65536});
   assert.ok(!probe.error,'guard rejection must finish before any bootstrap/UI');assert.notEqual(probe.status,0);
   assert.match(probe.stderr,ordinary?/SERIAL_MCP_FIXTURE_DISABLED/:native||badPrefix?/SERIAL_MCP_ROOT_REJECTED/:/SERIAL_MCP_REQUIRES_FIXTURE/);
   assert.deepEqual(await readdir(root),[],'guard must reject before any data-root mutation');count++;
  }
 }
 passed=true;await writeFile(`artifacts/P15-serial-v10-guards-${ordinary?'ordinary':'fixture'}.json`,JSON.stringify({result:'PASS',cases:count,no_data_root_mutation:true},null,2)+'\n');
 console.log('PASS serial MCP explicit build/CLI/root/fixture guards.');
}finally{if(passed)for(const root of roots){assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('shared-terminal-mcp-'));await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}else console.error('Owned guard failure roots retained:',roots);}
