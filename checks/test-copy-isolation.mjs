// The test copy's whole safety claim is that it shares no storage with the live hub.
// A reviewer compared the two configs once, by eye. This makes that comparison run
// on every change, because the dangerous edit is a future one: a copied ID, a
// restored binding, a route added "just to try it" that points the test Worker at
// Casey's real board. See hub job #14.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// wrangler.jsonc allows comments, so strip them before parsing. Line comments only;
// the configs use no block comments and no "//" inside a string value.
const read = (name) => JSON.parse(
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'),
);

const live = read('wrangler.jsonc');
const copy = read('wrangler.test.jsonc');

const d1 = (config) => config.d1_databases ?? [];
const kv = (config) => config.kv_namespaces ?? [];

test('the test copy is a different Worker from the live hub', () => {
  assert.notEqual(copy.name, live.name);
  assert.equal(copy.name, 'driftline-hub-test');
  assert.equal(copy.main, 'src/test-copy.ts', 'the test Worker must keep its own entrypoint');
  assert.equal(live.main, 'src/index.ts', 'the live hub must keep its own entrypoint');
});

test('the test copy writes to its own database, not Casey\'s', () => {
  const [test_db] = d1(copy);
  const liveIds = new Set(d1(live).map((binding) => binding.database_id));
  const liveNames = new Set(d1(live).map((binding) => binding.database_name));
  assert.ok(test_db, 'the test config must declare a database');
  assert.ok(!liveIds.has(test_db.database_id), 'test database_id must differ from every live one');
  assert.ok(!liveNames.has(test_db.database_name), 'test database_name must differ from every live one');
  assert.doesNotMatch(test_db.database_id, /UNPROVISIONED/i, 'provision the database before deploying');
});

test('the test copy signs people in against its own key store', () => {
  const [test_kv] = kv(copy);
  const liveIds = new Set(kv(live).map((binding) => binding.id));
  assert.ok(test_kv, 'the test config must declare an OAuth KV namespace');
  assert.ok(!liveIds.has(test_kv.id), 'test KV id must differ from every live one');
  assert.doesNotMatch(test_kv.id, /UNPROVISIONED/i, 'provision the KV namespace before deploying');
});

test('the test copy declares itself synthetic and keeps no live variables', () => {
  assert.equal(copy.vars?.HUB_TEST_COPY, 'synthetic-only',
    'src/test-copy.ts refuses to serve without this marker');
  assert.equal(copy.keep_vars, false,
    'keep_vars would preserve dashboard variables set on another Worker of the same name');
});

test('the test copy has no route, schedule or AI binding of its own', () => {
  for (const field of ['routes', 'route', 'triggers', 'crons', 'ai', 'queues', 'r2_buckets', 'services', 'durable_objects']) {
    assert.equal(copy[field], undefined, `the test Worker must not declare ${field}`);
  }
});
