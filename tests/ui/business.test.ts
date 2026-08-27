import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sourceUrl = new URL('../../public/views/business.js', import.meta.url);

test('Shia Baby exposes employee removal, restore, and honest pending states', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /api\.patch\(`\/api\/households\/\$\{state\.household\.id\}\/business\/employees\/\$\{employee\.id\}`/);
  assert.match(source, /Remove from active staff/);
  assert.match(source, /Restore to active staff/);
  assert.match(source, /Past shifts and business history will stay/);
  assert.match(source, /aria-busy/);
  assert.match(source, /Nothing was changed\. Try again\./);
});

test('inactive employees are excluded from active counts and scheduling pickers', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /filter\(\(employee\) => employee\.active !== false\)/);
  assert.match(source, /formerEmployees = allEmployees\.filter\(\(employee\) => employee\.active === false\)/);
  assert.match(source, /Not available for new shifts/);
});

test('overview employee rows are real links instead of inert chevrons', async () => {
  const source = await readFile(sourceUrl, 'utf8');

  assert.match(source, /h\('a', \{\s*class: 'business-list-row business-list-row--link'/);
  assert.match(source, /'aria-label': `Manage \$\{employee\.displayName\}`/);
});
