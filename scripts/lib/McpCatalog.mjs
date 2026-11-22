import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const v10 = JSON.parse(await readFile(new URL('../../contracts/mcp/v10-tools.json', import.meta.url), 'utf8'));
const legacyRead = v10.tools.find(tool => tool.name === 'terminal_read');
const textPage = tool => tool.inputSchema.$defs.View.oneOf
  .find(variant => variant.properties.kind.const === 'text').properties.max_bytes;

// Published previews and historical catalogs predate the metadata correction.
// Normalize only the description and the two bounds that were corrected.
export function legacyTerminalReadMetadata(tools) {
  const result = structuredClone(tools);
  const read = result.find(tool => tool.name === 'terminal_read');
  read.description = legacyRead.description;
  const page = textPage(read);
  page.minimum = textPage(legacyRead).minimum;
  delete page.maximum;
  return result;
}

export function assertReleasedMcpCatalog(actual, current, label) {
  assert.ok(isDeepStrictEqual(actual, current) ||
    isDeepStrictEqual(actual, legacyTerminalReadMetadata(current)), label);
}

export async function readMcpCatalog(version=12) {
  const previous=JSON.parse(await readFile(new URL('../../contracts/mcp/initial-tools.json',import.meta.url),'utf8'));
  assert.equal(previous.version,11);
  assert.equal(previous.tools.length,29);
  if(version===11)return previous;
  assert.equal(version,12);
  const current=JSON.parse(await readFile(new URL('../../contracts/mcp/v12-tools.json',import.meta.url),'utf8'));
  assert.equal(current.version,12);
  assert.deepEqual(current.tools.slice(0,previous.tools.length),previous.tools);
  assert.deepEqual(current.tools.slice(previous.tools.length).map(tool=>tool.name),
    ['shortcuts_list','shortcuts_create','shortcuts_update','shortcuts_remove']);
  return current;
}
