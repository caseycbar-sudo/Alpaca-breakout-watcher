import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('  const JOB_DRAFTS_STORAGE ='), source.indexOf('  // One source of truth'));
const input = (name, value = '', defaultValue = '') => ({name,value,defaultValue,tagName:'INPUT'});
const select = (name, value, defaults = ['claude','grok']) => ({name,value,tagName:'SELECT',options:defaults.map((value,i)=>({value,defaultSelected:i===0}))});
function form({id='job-form',version,fields=[input('title')],retryKey,open=true}={}) {
  const disclosure={open};
  return {id,elements:fields,dataset:{...(id!=='job-form'?{jobUpdate:id}:{}),...(version?{version}:{}),...(retryKey?{retryKey}:{})},notices:[],
    closest:()=>disclosure, prepend(...nodes){this.notices.push(...nodes);},
    reset(){for(const f of fields)f.value=f.tagName==='SELECT'?f.options[0].value:f.defaultValue;}};
}
function harness(forms=[], saved=[]) {
  let activeForms=forms, nextForms=forms;
  const view={querySelectorAll(selector){assert.equal(selector,'#job-form, form[data-job-update]');return activeForms;},contains:()=>true};
  Object.defineProperty(view,'innerHTML',{set(){activeForms=nextForms;}});
  const document={activeElement:{tagName:'SELECT',value:'grok'},createElement:tag=>({tagName:tag,dataset:{}})};
  const storage=new Map(saved); const sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  const listeners={}; const window={addEventListener:(name,fn)=>listeners[name]=fn,innerHeight:800,scrollY:0,scrollTo:()=>{}};
  const api=new Function('view','document','RENDER','badges','sliceKey','lastRendered','tab','measureChrome','S','sessionStorage','window',
    `${functions}; return {rememberJobDrafts,restoreJobDrafts,render,jobDrafts,persistJobDrafts};`)(view,document,{jobs:()=>'<new DOM>'},()=>{},()=>Math.random(),{},'jobs',()=>{},{},sessionStorage,window);
  return {...api,storage,listeners,show(forms){activeForms=forms;nextForms=forms;},rerender(forms){nextForms=forms;api.render(false);}};
}
test('automatic render preserves text, select choices and open disclosure with a select focused',()=>{
  const old=form({fields:[input('title','Write the review'),select('owner_id','grok')]});
  const h=harness([old]); const fresh=form({fields:[input('title'),select('owner_id','claude')],open:false});
  h.rerender([fresh]);
  assert.equal(fresh.elements[0].value,'Write the review'); assert.equal(fresh.elements[1].value,'grok'); assert.equal(fresh.closest().open,true);
});
test('a newer server version cannot silently replace the version attached to an unsaved draft',()=>{
  const h=harness([form({id:'12',version:'3',fields:[input('note','Original review')]})]);
  const fresh=form({id:'12',version:'4',fields:[input('note')]});h.rerender([fresh]);
  assert.equal(fresh.dataset.version,'3');assert.equal(fresh.elements[0].value,'Original review');
  assert.match(fresh.notices[0].textContent,/changed while you were editing/);
  assert.equal(fresh.notices[1].dataset.discardJobDraft,'true');
});
test('filtering a draft out and showing it again keeps that draft separate from other jobs',()=>{
  const h=harness([form({id:'12',version:'3',fields:[input('note','Job twelve')]})]); h.rememberJobDrafts();
  h.show([form({id:'13',version:'1',fields:[input('note','Job thirteen')]})]);h.rememberJobDrafts();
  const a=form({id:'12',version:'3',fields:[input('note')]});const b=form({id:'13',version:'1',fields:[input('note')]});
  h.show([a,b]);h.restoreJobDrafts();assert.equal(a.elements[0].value,'Job twelve');assert.equal(b.elements[0].value,'Job thirteen');
});
test('creation retry keys survive a re-render so uncertain submissions stay idempotent',()=>{
  const h=harness([form({retryKey:'same-retry-key',fields:[input('title','Task')]})]);
  const fresh=form();h.rerender([fresh]);assert.equal(fresh.dataset.retryKey,'same-retry-key');
});
test('successfully reset forms clear drafts rather than resurrecting submitted work',()=>{
  const original=form({fields:[input('title','Sent task')]});const h=harness([original]);h.rememberJobDrafts();
  original.reset();h.rememberJobDrafts();const fresh=form();h.show([fresh]);h.restoreJobDrafts();
  assert.equal(fresh.elements[0].value,'');assert.deepEqual(h.jobDrafts.get('create').values,{});
});
test('the implicit first select option does not create a phantom edit',()=>{
  const field=select('owner_id','claude');field.options.forEach(o=>o.defaultSelected=false);
  const h=harness([form({fields:[field]})]);h.rememberJobDrafts();assert.deepEqual(h.jobDrafts.get('create').values,{});assert.equal(h.jobDrafts.get('create').version,undefined);
});
test('matching versions do not show a conflict warning',()=>{
  const h=harness([form({id:'12',version:'3',fields:[input('note','A draft')]})]);const fresh=form({id:'12',version:'3',fields:[input('note')]});
  h.rerender([fresh]);assert.equal(fresh.notices.length,0);
});

test('an open untouched form stays open without pinning a stale task version',()=>{
  const h=harness([form({id:'12',version:'3',fields:[input('note')],open:true})]);
  const fresh=form({id:'12',version:'4',fields:[input('note')],open:false});h.rerender([fresh]);
  assert.equal(fresh.closest().open,true);assert.equal(fresh.dataset.version,'4');assert.equal(fresh.notices.length,0);
});

test('a real page reload restores an edited draft from this tab session only',()=>{
  const before=form({id:'12',version:'3',fields:[input('note','Survive reload')]});const first=harness([before]);
  first.listeners.pagehide();
  const after=form({id:'12',version:'3',fields:[input('note')]});const second=harness([after],[...first.storage]);second.restoreJobDrafts();
  assert.equal(after.elements[0].value,'Survive reload');assert.equal(after.dataset.version,'3');
});

test('open but untouched forms are not persisted across a real page reload',()=>{
  const first=harness([form({id:'12',version:'3',fields:[input('note')],open:true})]);first.listeners.pagehide();
  assert.equal(first.storage.size,0);
});

test('corrupt tab storage cannot block the hub',()=>{
  const bad=new Map([['driftline-job-drafts-v1','not-json']]);
  assert.doesNotThrow(()=>harness([form()],bad));
});
