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

function dereference(schema, root) {
  if (Array.isArray(schema)) return schema.map(value => dereference(value, root));
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    assert.match(schema.$ref, /^#\/\$defs\//);
    return dereference(root.$defs[schema.$ref.split('/').at(-1)], root);
  }
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !['$schema', '$defs', 'title'].includes(key))
    .map(([key, value]) => [key, dereference(value, root)]));
}

export function assertShortcutV2Catalog(current, legacy) {
  assert.equal(current.length, 33);
  assert.deepEqual(current.slice(0, 29), legacy.slice(0, 29));
  for (let index = 29; index < 33; index++) {
    const now = current[index], old = legacy[index];
    const schema = now.inputSchema;
    assert.equal(now.name, old.name);
    assert.deepEqual(now.annotations, old.annotations);
    assert.equal(schema.type, 'object');
    assert.equal(schema.anyOf.length, 2);
    assert.deepEqual(dereference(schema.anyOf[0], schema), dereference(old.inputSchema, old.inputSchema));
    const expanded = dereference(schema.anyOf[1], schema);
    assert.equal(expanded.additionalProperties, false);
    assert.ok(expanded.required.includes('version'));
    const version = expanded.properties.version;
    assert.deepEqual(version.const ? [version.const] : version.enum, ['v2']);
  }
}

export async function readMcpCatalog(version=13) {
  const previous=JSON.parse(await readFile(new URL('../../contracts/mcp/initial-tools.json',import.meta.url),'utf8'));
  assert.equal(previous.version,11);
  assert.equal(previous.tools.length,29);
  if(version===11)return previous;
  assert.ok(version===12||version===13);
  const current=JSON.parse(await readFile(new URL('../../contracts/mcp/v12-tools.json',import.meta.url),'utf8'));
  assert.equal(current.version,12);
  assert.deepEqual(current.tools.slice(0,previous.tools.length),previous.tools);
  assert.deepEqual(current.tools.slice(previous.tools.length).map(tool=>tool.name),
    ['shortcuts_list','shortcuts_create','shortcuts_update','shortcuts_remove']);
  if(version===12)return current;
  const expanded=JSON.parse(await readFile(new URL('../../contracts/mcp/v13-tools.json',import.meta.url),'utf8'));
  assert.equal(expanded.version,13);
  assertShortcutV2Catalog(expanded.tools,current.tools);
  return expanded;
}
