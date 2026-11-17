import { env as rawEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as jobs from '../src/tasks';
import type { Actor, Env } from '../src/util';
const env = rawEnv as unknown as Env;
const ai = (id:string,scopes=['hub:read','hub:log']):Actor=>({kind:'agent',id,name:id,scopes});
const chatgpt=ai('chatgpt'),claude=ai('claude'),grok=ai('grok');
const casey:Actor={kind:'owner',id:'casey',name:'Casey',scopes:[]};
let serial=0;
const create = async (input:Record<string,unknown>={},actor=chatgpt)=> (await jobs.createTask(env,actor,{title:'Implement a Hub improvement',description:'Scoped work on Driftline Trading Hub.',acceptance:'Test results and independent review.',owner_id:'chatgpt',reviewer_id:'claude',next_action:'Inspect the existing behavior.',idempotency_key:`test-${++serial}`,...input})).task;
const update = async (t:{id:number;version:number},action:string,actor=chatgpt,extra:Record<string,unknown>={})=>(await jobs.updateTask(env,actor,{id:t.id,expected_version:t.version,action,note:'Observed progress with scope and evidence.',next_action:'Perform the next scoped check.',...extra})).task;

describe('project jobs',()=>{
  it('keeps another agent’s assignment proposed until that agent accepts',async()=>{
    const t=await create({owner_id:'grok'});
    expect(t).toMatchObject({status:'proposed',assignment_confirmed:false});
    await expect(update(t,'accept')).rejects.toMatchObject({code:'not_assignee'});
    await expect(update(t,'start',grok)).rejects.toMatchObject({code:'not_accepted'});
    expect(await update(t,'accept',grok)).toMatchObject({status:'ready',assignment_confirmed:true});
  });
  it('protects read-only grants and identities, and rejects oversized values',async()=>{
    await expect(create({},ai('grok',['hub:read']))).rejects.toMatchObject({code:'not_permitted'});
    await expect(create({owner_id:'someone'})).rejects.toMatchObject({code:'bad_task'});
    await expect(create({title:'x'.repeat(181)})).rejects.toMatchObject({code:'bad_task'});
    await expect(create({owner_id:'chatgpt',reviewer_id:'chatgpt'})).rejects.toMatchObject({code:'bad_task'});
  });
  it('deduplicates concurrent creation retries with one audit record',async()=>{
    const key=`concurrent-${++serial}`;
    const results=await Promise.all([create({idempotency_key:key}),create({idempotency_key:key})]);
    expect(results[0].id).toBe(results[1].id);
    expect((await jobs.getTask(env,chatgpt,results[0].id)).history).toHaveLength(1);
  });
  it('requires acceptance criteria and real next actions',async()=>{
    await expect(create({acceptance:' '})).rejects.toMatchObject({code:'bad_task'});
    const t=await create();
    await expect(update(t,'start',chatgpt,{next_action:''})).rejects.toMatchObject({code:'bad_task'});
  });
  it('requires evidence and an independent assigned reviewer',async()=>{
    let t=await create();
    t=await update(t,'start');
    await expect(update(t,'submit')).rejects.toMatchObject({code:'bad_task'});
    t=await update(t,'submit',chatgpt,{evidence:'Commit abc; relevant tests passed locally. Not deployed.'});
    await expect(update(t,'complete')).rejects.toMatchObject({code:'not_reviewer'});
    await expect(update(t,'complete',grok)).rejects.toMatchObject({code:'not_reviewer'});
    t=await update(t,'complete',claude);
    expect(t.status).toBe('done');
    expect((await jobs.getTask(env,chatgpt,t.id)).history.map(e=>e.action)).toEqual(['created','start','submit','complete']);
    await expect(update(t,'progress')).rejects.toMatchObject({code:'task_closed'});
  });
  it('allows Casey to review agent work but not to claim work on their behalf',async()=>{
    let t=await create();
    await expect(update(t,'start',casey)).rejects.toMatchObject({code:'not_accepted'});
    t=await update(t,'start');t=await update(t,'submit',chatgpt,{evidence:'Verified test evidence.'});
    expect((await update(t,'complete',casey)).status).toBe('done');
  });
  it('hands off as a proposal, preserves history, and rejects stale writes',async()=>{
    const t=await create();
    const next=await update(t,'handoff',chatgpt,{owner_id:'grok'});
    expect(next).toMatchObject({owner_id:'grok',status:'proposed'});
    await expect(update(t,'cancel')).rejects.toMatchObject({code:'task_changed'});
    await expect(update(next,'progress',chatgpt)).rejects.toMatchObject({code:'not_worker'});
    expect((await jobs.getTask(env,chatgpt,t.id)).history).toHaveLength(2);
  });
  it('allows only one concurrent change and records just the winner',async()=>{
    const t=await create();
    const results=await Promise.allSettled([update(t,'start'),update(t,'handoff',chatgpt,{owner_id:'grok'})]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect((await jobs.getTask(env,chatgpt,t.id)).history).toHaveLength(2);
  });
  it('blocks dependent work until its prerequisite is independently reviewed',async()=>{
    let prior=await create();
    const t=await create({dependencies:[prior.id]});
    await expect(update(t,'start')).rejects.toMatchObject({code:'dependency_open'});
    prior=await update(prior,'start');prior=await update(prior,'submit',chatgpt,{evidence:'Prior checks complete.'});
    await update(prior,'complete',claude);
    expect((await update(t,'start')).status).toBe('in_progress');
    await expect(create({dependencies:[999999]})).rejects.toMatchObject({code:'no_such_task'});
  });
  it('keeps blockers concrete and supports rework without fabricating completion',async()=>{
    let t=await create();
    await expect(update(t,'block')).rejects.toMatchObject({code:'bad_task'});
    t=await update(t,'block',chatgpt,{blocker:'Read access to the test fixture is missing.'});
    expect(t.status).toBe('blocked');t=await update(t,'start');
    t=await update(t,'submit',chatgpt,{evidence:'Local check only.'});
    t=await update(t,'rework',claude,{note:'Please add the missing failure-path test.'});
    expect(t.status).toBe('ready');
  });
  it('paginates without dropping records and applies owner/status filters',async()=>{
    for(let i=0;i<4;i++) await create({owner_id:'grok'});
    const a=await jobs.listTasks(env,chatgpt,{owner_id:'grok',status:'proposed',limit:2});
    expect(a.has_more).toBe(true);
    const b=await jobs.listTasks(env,chatgpt,{owner_id:'grok',status:'proposed',limit:100,after_id:a.next_after_id!});
    expect(b.tasks.every(t=>t.id>a.next_after_id! && t.owner_id==='grok' && t.status==='proposed')).toBe(true);
    expect(b.has_more).toBe(false);
    await expect(jobs.listTasks(env,chatgpt,{status:'bogus'})).rejects.toMatchObject({code:'bad_task'});
  });
});
