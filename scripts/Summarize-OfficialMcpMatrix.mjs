import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertReleasedMcpCatalog } from './lib/McpCatalog.mjs';

const suites = {
  ssh: [
    'P15-terminal-wait-v11',
    'P22-security-v11',
    'P15-wait-impact-exec-v11',
    'P15-wait-impact-disconnect-v11',
    'P15-wait-impact-forget-v11',
    'P15-wait-impact-reconnect-v11',
    'P15-wait-impact-connect-v11',
    'P15-wait-impact-resize-v11',
    'P15-protected-export-v11',
  ],
  serial: [
    'P15-wait-impact-serial-connect-v11',
    'P15-wait-impact-serial-v11',
    'P15-wait-impact-disconnect-v11',
    'P15-wait-impact-forget-v11',
    'P15-protected-export-v11',
  ],
};
const readJson = async file => JSON.parse(await readFile(file,'utf8'));
const catalog = await readJson('contracts/mcp/initial-tools.json');
assert.equal(catalog.version,11);
assert.equal(catalog.tools.length,29);
const tools = Object.fromEntries(catalog.tools.map(tool => [tool.name,{
  deliveredSuccess:0, injectedLossSuccess:0, errors:{},
}]));
const cases = [];
let calls = 0;
let offCatalogDenied = 0;
for (const [transport,names] of Object.entries(suites)) {
  for (const name of names) {
    const evidence = 'P16-official-'+name+'-'+transport;
    const observed = await readJson(path.join('artifacts',evidence+'-calls.json'));
    const inventory = await readJson(path.join('artifacts',evidence.replace(/-(ssh|serial)$/,'-tools-$1')+'.json'));
    assert.equal(observed.result,'PASS',evidence);
    assert.equal(observed.modelTurns,0,evidence);
    assert.equal(observed.client,'official Codex app-server',evidence);
    assertReleasedMcpCatalog(inventory.tools,catalog.tools,evidence+' does not match a released v11 tool catalog');
    cases.push({transport,suite:name,calls:observed.observations.length});
    for (const row of observed.observations) {
      assert.equal(typeof row.outcome,'string',evidence);
      calls++;
      if (!Object.hasOwn(tools,row.tool)) {
        assert.notEqual(row.outcome,'OK',evidence);
        assert.equal(row.appServerReplyBeforeInjectedLoss,undefined,evidence);
        offCatalogDenied++;
        continue;
      }
      const counts = tools[row.tool];
      if (row.outcome === 'OK') counts.deliveredSuccess++;
      else counts.errors[row.outcome]=(counts.errors[row.outcome]??0)+1;
      if (row.appServerReplyBeforeInjectedLoss === 'OK') counts.injectedLossSuccess++;
    }
  }
}
const missing = Object.keys(tools).filter(name => !tools[name].deliveredSuccess && !tools[name].injectedLossSuccess);
const injectedLossOnly = Object.keys(tools).filter(name => !tools[name].deliveredSuccess && tools[name].injectedLossSuccess);
const result = {
  result:missing.length ? 'INCOMPLETE' : 'PASS', catalogVersion:catalog.version,
  client:'installed official Codex app-server', cases, calls, offCatalogDenied,
  covered:catalog.tools.length-missing.length, modelTurns:0, missing, injectedLossOnly, tools,
};
await writeFile('artifacts/P16-official-29-tool-matrix.json',JSON.stringify(result,null,2)+'\n');
assert.deepEqual(missing,[]);
console.log('PASS '+result.covered+' official positive tool replies across '+cases.length+' cases, '+calls+' total calls');
