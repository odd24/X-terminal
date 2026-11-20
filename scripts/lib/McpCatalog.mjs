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
