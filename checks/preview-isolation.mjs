// A Preview of a pull request runs this same Worker code at its own URL. The one
// thing standing between an experiment and Casey's real board is the previews
// block pointing somewhere else. Wrangler refuses to deploy a Preview while that
// block is missing entirely; it cannot tell whether an id someone pasted into it
// is the live one. That is what these check. See hub job #14.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const read = (name) => JSON.parse(
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'),
);

const config = read('wrangler.jsonc');
const previews = config.previews;
const migrations = read('wrangler.preview-migrations.jsonc');

const liveDbIds = new Set((config.d1_databases ?? []).map((b) => b.database_id));
const liveDbNames = new Set((config.d1_databases ?? []).map((b) => b.database_name));
const liveKvIds = new Set((config.kv_namespaces ?? []).map((b) => b.id));

test('a previews block exists at all', () => {
  assert.ok(previews, 'without it wrangler preview fails and no pull request can be tested');
});

test('previews read and write their own database', () => {
  const [db] = previews.d1_databases ?? [];
  assert.ok(db, 'a preview with no database binding falls back to nothing, not to safety');
  assert.ok(!liveDbIds.has(db.database_id), 'preview database_id must not be the live one');
  assert.ok(!liveDbNames.has(db.database_name), 'preview database_name must not be the live one');
});

test('previews sign people in against their own key store', () => {
  const [kv] = previews.kv_namespaces ?? [];
  assert.ok(kv, 'sharing the live OAuth namespace would share live sign-ins');
  assert.ok(!liveKvIds.has(kv.id), 'preview KV id must not be the live one');
});

test('a preview says on every page that it is not the real hub', () => {
  assert.equal(previews.vars?.HUB_ENV, 'preview');
  assert.equal(config.vars?.HUB_ENV, undefined,
    'production must not set this, or the live hub would label itself a test copy');
});

test('previews take no route, schedule or watcher token of their own', () => {
  for (const field of ['routes', 'route', 'triggers', 'crons']) {
    assert.equal(previews[field], undefined, `previews must not declare ${field}`);
  }
});

test('the migration config points at the same database the previews use', () => {
  const [db] = previews.d1_databases ?? [];
  const [target] = migrations.d1_databases ?? [];
  assert.ok(target, 'migrations need a database to apply to');
  assert.equal(target.database_id, db.database_id,
    'migrations applied to a different database than the preview reads leave the preview broken');
  assert.equal(target.database_name, db.database_name);
  assert.ok(!liveDbIds.has(target.database_id),
    'this config is run with --remote, so a live id here would migrate Casey\'s own database');
});
