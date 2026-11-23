import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// Grok appended a styling block to the end of app.css redefining .v2-hero, 358
// lines below the original. Both rules were valid, the later one won, and the
// designed hero quietly became a plain gradient. Nothing failed; the page just
// got worse. Markup tests cannot catch this, because the markup was never wrong.
//
// app.css is deliberately two layers: a mobile-first base, then a workspace layer
// starting at the second :root that restyles it wider. A workspace rule overriding
// a base rule is the architecture working. A workspace rule overriding ANOTHER
// workspace rule is the accident above, so that is what this checks.

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const roots = [...css.matchAll(/^:root\s*\{/gm)].map((m) => m.index);
assert.ok(roots.length >= 2, 'expected a base :root and a workspace :root');
const workspace = css.slice(roots[1]);

// Collect top-level selectors, skipping the bodies of @media and @supports: a rule
// inside one is meant to override its base, which is the cascade working as intended.
function topLevelRules(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0, selector = '', atRuleDepth = null;
  for (const ch of clean) {
    if (ch === '{') {
      depth++;
      if (depth === 1) {
        const sel = selector.trim();
        if (sel.startsWith('@')) atRuleDepth = depth;
        else rules.push(sel);
      }
      selector = '';
    } else if (ch === '}') {
      if (atRuleDepth === depth) atRuleDepth = null;
      depth--;
      selector = '';
    } else if (depth === 0 || (atRuleDepth !== null && depth === atRuleDepth)) {
      selector += ch;
    }
  }
  return rules;
}

// The workspace layer has itself accreted several restyling passes, so 45 selectors
// were already shadowing each other before this check existed. Deduplicating them
// is a real refactor that needs a browser to verify, so they are recorded as a
// baseline instead of pretended away. This fails on the 46th, which is the one that
// would be somebody's change rather than history.
const baseline = new Set(JSON.parse(
  readFileSync(new URL('./fixtures/css-duplicate-baseline.json', import.meta.url), 'utf8')));

test('no new workspace-layer selector starts shadowing another', () => {
  const seen = new Set();
  const shadowed = [];
  for (const rule of topLevelRules(workspace)) {
    for (const sel of rule.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
      if (sel === ':root') continue;
      if (seen.has(sel)) shadowed.push(sel);
      else seen.add(sel);
    }
  }
  const added = [...new Set(shadowed)].filter((s) => !baseline.has(s));
  assert.deepStrictEqual(added, [],
    `newly redefined in the workspace layer, so the later block silently wins:\n  ${added.join('\n  ')}\n` +
    `If the override is deliberate, edit the original rule instead of adding a second one.`);
});

test('the duplicate baseline does not quietly grow stale', () => {
  // A selector that leaves the baseline is progress, but the file should say so
  // rather than carrying a name that no longer means anything.
  const seen = new Set();
  const shadowed = new Set();
  for (const rule of topLevelRules(workspace)) {
    for (const sel of rule.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
      if (sel === ':root') continue;
      if (seen.has(sel)) shadowed.add(sel);
      else seen.add(sel);
    }
  }
  const fixed = [...baseline].filter((s) => !shadowed.has(s));
  assert.deepStrictEqual(fixed, [],
    `no longer duplicated, so remove from the baseline: ${fixed.join(', ')}`);
});

test('every custom property the stylesheet uses is defined in it or set at runtime', () => {
  // .news-strip .news-item p asked for var(--muted), which was never defined, so the
  // supporting line under each headline silently kept its inherited colour. The CSP
  // forbids inline styles, so the few runtime properties are set via setProperty.
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  for (const m of appJs.matchAll(/setProperty\(\s*["'](--[a-z0-9-]+)["']/gi)) defined.add(m[1]);
  for (const m of appJs.matchAll(/put\(\s*["'](--[a-z0-9-]+)["']/gi)) defined.add(m[1]);

  const missing = [...new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(?:,|\))/gi)].map((m) => m[1]))]
    .filter((v) => !defined.has(v));
  assert.deepStrictEqual(missing, [],
    `used but never defined, so these fall back to nothing: ${missing.join(', ')}`);
});
