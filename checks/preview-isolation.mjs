// A Preview of a pull request runs this same Worker code at its own URL. The one
// thing standing between an experiment and Casey's real board is the previews
// block pointing somewhere else. Wrangler refuses to deploy a Preview while that
// block is missing entirely; it cannot tell whether an id someone pasted into it
// is the live one. That is what these check. See hub job #14.
//
// The rules are a function of two configs rather than a reading of the files, so
// that a config which SHOULD fail can be fed in and proved to fail. ChatGPT found
// why that matters: the first version looked at the first binding of each kind
// only, so a second binding added later, pointing at production, would have
// sailed through. Every binding is checked now, and the negative cases below put
// the live id in second position on purpose.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const read = (name) => JSON.parse(
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'),
);

const BAD_ID = /^\s*$|UNPROVISIONED|REPLACE_ME|TODO|CHANGE_?ME/i;
const EXPECTED_D1 = ['DB'];
const EXPECTED_KV = ['OAUTH_KV'];

/** Everything wrong with this pair of configs, as plain sentences. Empty means fine. */
export function isolationProblems(live, preview, migrations) {
  const problems = [];
  const say = (s) => problems.push(s);

  if (!preview) {
    say('there is no previews block, so wrangler preview cannot deploy at all');
    return problems;
  }

  const liveD1 = live.d1_databases ?? [];
  const liveKv = live.kv_namespaces ?? [];
  const previewD1 = preview.d1_databases ?? [];
  const previewKv = preview.kv_namespaces ?? [];

  // Compare against every live id, and check every preview binding, not the first.
  const liveDbIds = new Set(liveD1.map((b) => b.database_id).filter(Boolean));
  const liveDbNames = new Set(liveD1.map((b) => b.database_name).filter(Boolean));
  const liveKvIds = new Set(liveKv.map((b) => b.id).filter(Boolean));

  const d1Names = previewD1.map((b) => b.binding);
  const kvNames = previewKv.map((b) => b.binding);
  if (d1Names.join() !== EXPECTED_D1.join()) {
    say(`previews.d1_databases should bind exactly ${EXPECTED_D1.join(', ')}, not ${d1Names.join(', ') || 'nothing'}`);
  }
  if (kvNames.join() !== EXPECTED_KV.join()) {
    say(`previews.kv_namespaces should bind exactly ${EXPECTED_KV.join(', ')}, not ${kvNames.join(', ') || 'nothing'}`);
  }

  previewD1.forEach((b, i) => {
    const where = `previews.d1_databases[${i}] (${b.binding ?? 'unnamed'})`;
    if (!b.database_id || BAD_ID.test(b.database_id)) say(`${where} has no usable database_id`);
    if (liveDbIds.has(b.database_id)) say(`${where} is the live hub's database`);
    if (liveDbNames.has(b.database_name)) say(`${where} names the live hub's database`);
  });

  previewKv.forEach((b, i) => {
    const where = `previews.kv_namespaces[${i}] (${b.binding ?? 'unnamed'})`;
    if (!b.id || BAD_ID.test(b.id)) say(`${where} has no usable id`);
    if (liveKvIds.has(b.id)) say(`${where} is the live hub's sign-in store`);
  });

  if (preview.vars?.HUB_ENV !== 'preview') say('previews.vars.HUB_ENV must be "preview", or a Preview will not label itself');
  if (live.vars?.HUB_ENV !== undefined) say('production must not set HUB_ENV, or the live hub would label itself a test copy');

  for (const field of ['routes', 'route', 'triggers', 'crons']) {
    if (preview[field] !== undefined) say(`previews must not declare ${field}`);
  }

  if (migrations) {
    const targets = migrations.d1_databases ?? [];
    if (!targets.length) say('the migration config has no database to apply to');
    targets.forEach((t, i) => {
      const where = `the migration config's d1_databases[${i}]`;
      // It is run with --remote, so a live id here migrates Casey's own database.
      if (liveDbIds.has(t.database_id)) say(`${where} is the live hub's database`);
      if (!previewD1.some((b) => b.database_id === t.database_id && b.database_name === t.database_name)) {
        say(`${where} is not a database any Preview reads, so migrations would land somewhere unused`);
      }
    });
  }

  return problems;
}

// ---------------------------------------------------------------- the real files

const live = read('wrangler.jsonc');
const migrations = read('wrangler.preview-migrations.jsonc');

test('the configs in this repo keep previews off the live hub', () => {
  assert.deepEqual(isolationProblems(live, live.previews, migrations), []);
});

test('the live hub is still bound to its own storage', () => {
  assert.equal(live.d1_databases?.[0]?.database_name, 'driftline-trading-hub');
  assert.ok(live.kv_namespaces?.[0]?.id);
});

// ------------------------------------------------- configs that have to be caught

const liveFixture = {
  vars: {},
  d1_databases: [{ binding: 'DB', database_name: 'live-db', database_id: 'LIVE-DB' }],
  kv_namespaces: [{ binding: 'OAUTH_KV', id: 'LIVE-KV' }],
};
const okPreview = {
  vars: { HUB_ENV: 'preview' },
  d1_databases: [{ binding: 'DB', database_name: 'test-db', database_id: 'TEST-DB' }],
  kv_namespaces: [{ binding: 'OAUTH_KV', id: 'TEST-KV' }],
};
const okMigrations = { d1_databases: [{ binding: 'PREVIEW_DB', database_name: 'test-db', database_id: 'TEST-DB' }] };
const caught = (preview, migrations = okMigrations) => isolationProblems(liveFixture, preview, migrations);

test('a preview with no block at all is caught', () => {
  assert.equal(caught(undefined).length, 1);
});

test('the live database in the FIRST preview binding is caught', () => {
  const problems = caught({ ...okPreview, d1_databases: [{ binding: 'DB', database_name: 'live-db', database_id: 'LIVE-DB' }] });
  assert.ok(problems.some((p) => p.includes("is the live hub's database")), problems.join('; '));
});

test('the live database in a SECOND preview binding is caught', () => {
  // The case the first version of this check missed: the first binding is fine,
  // so looking only at the first binding saw nothing wrong.
  const problems = caught({
    ...okPreview,
    d1_databases: [...okPreview.d1_databases, { binding: 'ARCHIVE', database_name: 'live-db', database_id: 'LIVE-DB' }],
  });
  assert.ok(problems.some((p) => p.includes('d1_databases[1]') && p.includes("is the live hub's database")), problems.join('; '));
  assert.ok(problems.some((p) => p.includes('should bind exactly DB')), problems.join('; '));
});

test('the live sign-in store in a SECOND preview binding is caught', () => {
  const problems = caught({
    ...okPreview,
    kv_namespaces: [...okPreview.kv_namespaces, { binding: 'SPARE', id: 'LIVE-KV' }],
  });
  assert.ok(problems.some((p) => p.includes('kv_namespaces[1]') && p.includes("is the live hub's sign-in store")), problems.join('; '));
});

test('a blank or placeholder id never reaches a deploy', () => {
  for (const id of ['', '   ', 'UNPROVISIONED-TEST-DATABASE', '<REPLACE_ME>', 'TODO']) {
    const problems = caught({ ...okPreview, d1_databases: [{ binding: 'DB', database_name: 'test-db', database_id: id }] });
    assert.ok(problems.some((p) => p.includes('no usable database_id')), `${JSON.stringify(id)}: ${problems.join('; ')}`);
  }
});

test('a missing or wrong label is caught, in either direction', () => {
  assert.ok(caught({ ...okPreview, vars: {} }).some((p) => p.includes('HUB_ENV must be')));
  assert.ok(
    isolationProblems({ ...liveFixture, vars: { HUB_ENV: 'preview' } }, okPreview, okMigrations)
      .some((p) => p.includes('production must not set HUB_ENV')),
  );
});

test('a route or schedule added to previews is caught', () => {
  for (const field of ['routes', 'route', 'triggers', 'crons']) {
    assert.ok(caught({ ...okPreview, [field]: ['anything'] }).some((p) => p.includes(field)));
  }
});

test('migrations aimed at the live database, or at nothing a preview reads, are caught', () => {
  assert.ok(
    caught(okPreview, { d1_databases: [{ binding: 'PREVIEW_DB', database_name: 'live-db', database_id: 'LIVE-DB' }] })
      .some((p) => p.includes("is the live hub's database")),
  );
  assert.ok(
    caught(okPreview, { d1_databases: [{ binding: 'PREVIEW_DB', database_name: 'other', database_id: 'OTHER' }] })
      .some((p) => p.includes('not a database any Preview reads')),
  );
  assert.ok(caught(okPreview, { d1_databases: [] }).some((p) => p.includes('no database to apply to')));
});
