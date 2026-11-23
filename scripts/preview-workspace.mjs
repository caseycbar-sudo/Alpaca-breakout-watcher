// Generate a static, synthetic review copy; no Hub or broker requests can leave it.
// Usage: node scripts/preview-workspace.mjs /absolute/output/directory
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const destination = process.argv[2];
if (!destination) throw new Error('Pass an output directory outside the source checkout.');
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const shell = read('src/pages.ts').match(/`(<div id="app"[\s\S]*?)`/)[1];
const state = JSON.parse(read('checks/fixtures/workspace-state.json'));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TEST · Driftline workspace facelift</title><link rel="stylesheet" href="app.css"></head><body><p style="padding:10px;text-align:center;background:#643c16;color:white">SYNTHETIC DESIGN PREVIEW · no account connection</p>${shell}<script>const fixture=${JSON.stringify(state)};window.fetch=async(path,opts)=>{if(path!=="/api/state"||opts?.method==="POST")throw new Error("This synthetic preview cannot save changes");return {ok:true,status:200,json:async()=>fixture};};sessionStorage.setItem("tab","today");</script><script src="app.js"></script></body></html>`;
const out = resolve(destination);
mkdirSync(out, {recursive:true});
writeFileSync(join(out,'index.html'), html);
writeFileSync(join(out,'app.js'), read('public/app.js'));
writeFileSync(join(out,'app.css'), read('public/app.css'));
writeFileSync(join(out,'mobile.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Phone preview · Driftline</title></head><body style="margin:0;background:#080f1b;display:grid;place-items:center"><iframe title="390px phone preview" src="./index.html" style="width:390px;height:844px;border:1px solid #4e6577"></iframe></body></html>');
console.log(`Synthetic preview generated in ${out}`);
