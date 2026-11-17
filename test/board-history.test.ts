import { env as rawEnv } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import * as db from '../src/db';
import type { Actor, Env } from '../src/util';
const env=rawEnv as unknown as Env;
const actor:Actor={kind:'agent',id:'grok',name:'Grok',scopes:['hub:read','hub:snapshot']};
const pos={symbol:'QQQ',quantity:1};
const time=Date.now();
const priorTime=time-3*3600000;
const historical=(board:Awaited<ReturnType<typeof db.buildBoard>>)=>board.historical_details;
async function snapshot(at:number,values:Record<string,unknown>){return db.postSnapshot(env,actor,{source:'Broker read reported by Grok',observed_at:new Date(at).toISOString(),...values});}
beforeEach(async()=>{await env.DB.prepare('DELETE FROM snapshots').run();});
describe('partial report history',()=>{
  it('keeps prior warnings dated without promoting old holdings or capacity into a fresh report',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time,{cash:100});
    const b=await db.buildBoard(env,time);
    expect(b.snapshot).toMatchObject({positions:null,open_orders:null,position_count:null,stale:false});
    expect(b.rules.slots_left).toBeNull();
    expect(historical(b)).toHaveLength(1);
    expect(historical(b)[0].text).toContain(new Date(priorTime).toISOString());
    expect(historical(b)[0].text).toContain('3 hours ago');
    expect(historical(b)[0].text).toContain('current protection is unknown');
    expect(historical(b)[0].text).toContain('reported by Grok');
  });
  it('does not revive a warning superseded by a later comparable protected report',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time-1000,{positions:[pos],open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400}]});
    await snapshot(time,{cash:100});
    expect(historical(await db.buildBoard(env,time))).toHaveLength(0);
  });
  it('clears historical position warnings when a current explicitly empty holdings list is reported',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time,{positions:[]});
    expect(historical(await db.buildBoard(env,time))).toHaveLength(0);
  });
  it('does not resurrect a warning already retired by a later partial holdings report',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time-1000,{positions:[]});
    await snapshot(time,{cash:100});
    const b=await db.buildBoard(env,time);
    expect(b.snapshot?.positions).toBeNull();
    expect(historical(b)).toHaveLength(0);
  });
  it('retains a partial-coverage warning when current holdings are reported but orders are omitted',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:0.5,stop_price:400}]});
    await snapshot(time,{positions:[pos]});
    const b=await db.buildBoard(env,time);
    expect(historical(b)[0].text).toContain('had only partial stop protection');
    expect(historical(b)[0].text).toContain('latest report omits open orders');
  });
  it('uses observation order rather than upload order and never labels historical warnings current',async()=>{
    await snapshot(time-1000,{positions:[pos],open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400}]});
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time,{cash:100});
    expect(historical(await db.buildBoard(env,time))).toHaveLength(0);
  });
  it('acknowledges a later order-only report without promoting old holdings into current coverage',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    const orderTime=time-1000;
    await snapshot(orderTime,{open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400}]});
    await snapshot(time,{cash:100});
    const b=await db.buildBoard(env,time);
    expect(historical(b)[0].text).toContain('includes a sell stop for QQQ');
    expect(historical(b)[0].text).toContain(new Date(orderTime).toISOString());
    expect(historical(b)[0].text).toContain('does not confirm current quantities or coverage');
    expect(b.snapshot).toMatchObject({positions:null,open_orders:null});
    expect(b.rules.slots_left).toBeNull();
  });
  it('acknowledges the current report’s own stop orders while holdings remain unknown',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time,{open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400}]});
    const b=await db.buildBoard(env,time);
    expect(historical(b)[0].text).toContain('includes a sell stop for QQQ');
    expect(historical(b)[0].text).toContain(new Date(time).toISOString());
    expect(b.snapshot?.positions).toBeNull();
    expect(b.rules.slots_left).toBeNull();
  });
  it('combines current order uncertainty and historical warnings into one symbol warning',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time,{positions:[pos]});
    const b=await db.buildBoard(env,time);
    expect(b.exceptions.filter(e=>e.text.includes('QQQ'))).toHaveLength(1);
    expect(historical(b)[0].text).toContain('current protection is unknown');
  });
  it('does not treat a terminal stop record as later protection evidence',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time,{open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400,status:'cancelled'}]});
    expect(historical(await db.buildBoard(env,time))[0].text).not.toContain('includes a sell stop');
  });
  it('uses the latest order report so an intervening stop is not presented after an explicitly empty order report',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time-2000,{open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400}]});
    await snapshot(time-1000,{open_orders:[]});
    await snapshot(time,{cash:100});
    expect(historical(await db.buildBoard(env,time))[0].text).not.toContain('includes a sell stop');
  });
  it('retains another reporter’s warning without claiming matching account identity',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await db.postSnapshot(env,{...actor,id:'chatgpt',name:'ChatGPT'},{source:'Broker read reported by Grok',observed_at:new Date(time).toISOString(),cash:100});
    const b=await db.buildBoard(env,time);
    expect(historical(b)).toHaveLength(1);
    expect(historical(b)[0].text).toContain('different reporter/source connection');
    expect(historical(b)[0].text).toContain('may not be the same account');
    expect(b.snapshot?.positions).toBeNull();
    expect(b.rules.slots_left).toBeNull();
  });
  it('retains source-separated warnings without treating labels as account identity',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await db.postSnapshot(env,actor,{source:'Another broker connection',observed_at:new Date(time-1000).toISOString(),cash:100});
    const other=historical(await db.buildBoard(env,time));
    expect(other).toHaveLength(1);
    expect(other[0].text).toContain('may not be the same account');
    await snapshot(time,{cash:100});
    expect(historical(await db.buildBoard(env,time))[0].text).toContain('Account identity is not recorded');
  });

  it('does not retire another connection’s unresolved warning when a new reporter files a complete protected report',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await db.postSnapshot(env,{...actor,id:'chatgpt',name:'ChatGPT'},{source:'Other reporter',observed_at:new Date(time).toISOString(),positions:[pos],open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400}]});
    const b=await db.buildBoard(env,time);
    expect(historical(b)).toHaveLength(1);
    expect(historical(b)[0].text).toContain('reported by Grok');
    expect(historical(b)[0].text).not.toContain('includes a sell stop');
  });
  it('does not let one reporter’s empty holdings list retire a different reporter’s warning',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await db.postSnapshot(env,{...actor,id:'chatgpt',name:'ChatGPT'},{source:'Other reporter',observed_at:new Date(time).toISOString(),positions:[]});
    expect(historical(await db.buildBoard(env,time))).toHaveLength(1);
  });
  it('does not resurrect an earlier warning once its own source later reports protection, even when another reporter posts next',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time-1000,{positions:[pos],open_orders:[{symbol:'QQQ',side:'sell',type:'stop',quantity:1,stop_price:400}]});
    await db.postSnapshot(env,{...actor,id:'chatgpt',name:'ChatGPT'},{source:'Other reporter',observed_at:new Date(time).toISOString(),cash:100});
    expect(historical(await db.buildBoard(env,time))).toHaveLength(0);
  });

  it('moves other-source reports older than 72 elapsed hours to retained quiet history',async()=>{
    const old=time-72*3600000-1;
    await snapshot(old,{positions:[pos],open_orders:[]});
    await db.postSnapshot(env,{...actor,id:'chatgpt',name:'ChatGPT'},{source:'Other reporter',observed_at:new Date(time).toISOString(),positions:[pos]});
    const b=await db.buildBoard(env,time);
    expect(historical(b)).toHaveLength(0);
    expect(b.historical_notices).toHaveLength(1);
    expect(b.historical_notices[0].text).toContain(new Date(old).toISOString());
    expect(b.historical_notices[0].text).toContain('reported by Grok');
    expect(b.historical_notices[0].text).toContain('may not be the same account');
    expect(b.exceptions.some(e=>e.text.includes('QQQ: open orders were not reported'))).toBe(true);
    expect(b.snapshot?.open_orders).toBeNull();
  });
  it('keeps other-source history active at exactly 72 elapsed hours',async()=>{
    await snapshot(time-72*3600000,{positions:[pos],open_orders:[]});
    await db.postSnapshot(env,{...actor,id:'chatgpt',name:'ChatGPT'},{source:'Other reporter',observed_at:new Date(time).toISOString(),cash:100});
    const b=await db.buildBoard(env,time);
    expect(historical(b)).toHaveLength(1);
    expect(b.historical_notices).toHaveLength(0);
  });
  it('keeps same-source uncertainty active even when its supporting report is old',async()=>{
    await snapshot(time-7*24*3600000,{positions:[pos],open_orders:[]});
    await snapshot(time,{cash:100});
    const b=await db.buildBoard(env,time);
    expect(historical(b)).toHaveLength(1);
    expect(b.historical_notices).toHaveLength(0);
    expect(b.rules.slots_left).toBeNull();
  });

  it('keeps one short flag per symbol and retains each source report in detail',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await db.postSnapshot(env,{...actor,id:'claude',name:'Claude'},{source:'Other history',observed_at:new Date(priorTime+1000).toISOString(),positions:[pos],open_orders:[]});
    await snapshot(time,{cash:100});
    const b=await db.buildBoard(env,time);
    const flags=b.exceptions.filter(e=>e.text.includes('QQQ'));
    expect(flags).toHaveLength(1);
    expect(flags[0].text.length).toBeLessThan(150);
    expect(flags[0].text).not.toContain('snapshot #');
    expect(historical(b)).toHaveLength(2);
    expect(historical(b).some(e=>e.text.includes('reported by Claude'))).toBe(true);
    expect(historical(b).some(e=>e.text.includes('reported by Grok'))).toBe(true);
  });
  it('places current stop flags before historical and informational warnings',async()=>{
    await snapshot(priorTime,{positions:[pos],open_orders:[]});
    await snapshot(time,{positions:[pos,{symbol:'SPY',quantity:1},{symbol:'IWM',quantity:1}]});
    const b=await db.buildBoard(env,time);
    expect(b.exceptions[0]).toMatchObject({level:'stop'});
    expect(b.exceptions[0].text).toContain('3 positions');
    expect(historical(b)).toHaveLength(1);
  });

});
