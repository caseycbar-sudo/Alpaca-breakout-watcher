import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const scope = {URL};
runInNewContext(readFileSync(new URL('../public/research-desk.js',import.meta.url),'utf8'),scope);
const desk = scope.HubResearchDesk;
test('small position scenario includes costs in both outcomes and break-even probability',()=>{
  const r = desk.costModel(5,10,20,0.2);
  assert.equal(r.gain,0.49); assert.equal(r.loss,1.01);
  assert.ok(Math.abs(r.breakEven-67.3333333333)<0.0001);
  assert.equal(desk.costModel(5,0.1,20,0.2).breakEven,null);
  for (const inputs of [[0,10,20,0], [5,10,100,0], [5,10,20,-1], [NaN,10,20,0]]) assert.equal(desk.costModel(...inputs),null);
});
test('untrusted headlines are escaped and unsafe source links are never rendered',()=>{
  const html = desk.render({server_time:Date.parse('2026-11-23T12:00:00Z'),radar:{candidates:[{symbol:'QQQ',news:{headline:'<script>alert(1)</script>',url:'javascript:alert(1)',published_at:'2026-11-23T11:55:00Z',first_seen_at:'2026-11-23T11:56:00Z'}}]}});
  assert.doesNotMatch(html,/<script>|href="javascript:/);
  assert.match(html,/&#60;script&#62;/); assert.match(html,/Published 5 min ago/);
  assert.match(html,/2026-11-23T11:56:00Z/);
  assert.equal(desk.safeUrl('https://user:secret@example.com'),null);
});
test('symbol focus filters candidate headlines and refuses malformed ticker input',()=>{
  const state = {radar:{candidates:[{symbol:'QQQ',news:{headline:'Q story'}},{symbol:'PSQ',news:{headline:'P story'}}]},board:{snapshot:{positions:[{symbol:'QQQ'}]}}};
  assert.equal(desk.news(state,'QQQ').length,1);
  assert.equal(desk.symbol(' qqq '),'QQQ'); assert.equal(desk.symbol('<script>'),'');
  assert.equal(desk.symbols(state).length,2);
  const html = desk.render(state,'QQQ','short');
  assert.match(html,/data-resource-group="short"/); assert.doesNotMatch(html,/data-resource-group="options"/);
  assert.match(html,/Not reported/); assert.doesNotMatch(html,/P story/);
});
test('empty and future observations never read as fresh or a complete news search',()=>{
  const html = desk.render({server_time:Date.parse('2026-11-23T12:00:00Z'),radar:{generated_at:'2026-11-24T12:00:00Z',candidates:[]}});
  assert.match(html,/timestamp ahead of this sync/); assert.match(html,/not a complete news search/);
  assert.match(html,/Options, short-interest and disclosure data have not been imported/);
  assert.match(html,/Not read this session/);
});
test('policy source failures are visible and date-only publication is never an intraday timestamp',()=>{
  const html = desk.render({policy:{checked_at:'2026-11-23T12:00:00Z',problem:'HTTP 503',items:[]}});
  assert.match(html,/Policy source unavailable: HTTP 503/);
  assert.match(html,/Publication dates are calendar dates/);
});
test('stylesheet retains the complete layout after the truncated upstream replacement',()=>{
  const css = readFileSync(new URL('../public/app.css',import.meta.url),'utf8');
  assert.doesNotMatch(css,/truncated for tool limit|<<<<<<<|>>>>>>>/);
  for (const selector of ['.app {','.tabs {','.sheet {','.command-deck {','.intel-desk {','.flash-card {']) assert.ok(css.includes(selector),selector);
});
