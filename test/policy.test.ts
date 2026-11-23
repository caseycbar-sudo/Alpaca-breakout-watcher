import {it,expect,vi,afterEach} from 'vitest';
import {cleanPolicy} from '../src/policy';
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
it('accepts only expected public document URLs and preserves separate publication and effective dates',()=>{
  const results = cleanPolicy({results:[{title:'A rule',html_url:'https://www.federalregister.gov/documents/example',publication_date:'2026-11-23',effective_on:'2026-12-01',type:'Rule',agencies:[{name:'Example agency'}]},{title:'bad',html_url:'https://evil.example/'}]});
  expect(results).toHaveLength(1); expect(results[0].effective_on).toBe('2026-12-01');
  expect(results[0].publication_date).toBe('2026-11-23');
  expect(()=>cleanPolicy({results:null})).toThrow('unreadable');
});
it('shares the read and caches a successful response without passing account information',async()=>{
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({results:[]})));
  vi.stubGlobal('fetch',fetcher);
  const {getPolicy} = await import('../src/policy');
  const [one,two] = await Promise.all([getPolicy(),getPolicy()]);
  expect(one.items).toEqual([]);expect(two.problem).toBeNull();
  expect((await getPolicy()).cached).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
  const [url,opts] = fetcher.mock.calls[0];
  expect(url).toMatch(/^https:\/\/www\.federalregister\.gov\/api\/v1\/documents\.json/);
  expect(opts.headers).toEqual({Accept:'application/json'});
});
it('returns an explicit failure instead of an empty successful feed',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('down',{status:503})));
  const {getPolicy} = await import('../src/policy');
  expect((await getPolicy()).problem).toContain('HTTP 503');
});
