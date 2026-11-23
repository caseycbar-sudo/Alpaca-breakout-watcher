// One public, fixed upstream. No account data, user query or credentials leave the Hub.
const SOURCE = "https://www.federalregister.gov/api/v1/documents.json?per_page=8&order=newest&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=html_url&fields%5B%5D=type&fields%5B%5D=agencies&fields%5B%5D=effective_on";
const TTL = 10 * 60 * 1000;
const MAX_BYTES = 180_000;
type PolicyItem = { title: string; url: string; publication_date: string | null; effective_on: string | null; type: string; agencies: string[] };
export type PolicyReport = { source: string; checked_at: string; items: PolicyItem[]; problem: string | null; cached: boolean };
let cached: { at: number; report: PolicyReport } | null = null;
let pending: Promise<PolicyReport> | null = null;
const text = (x: unknown, n: number) => typeof x === "string" ? x.slice(0,n) : "";
const date = (x: unknown) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
export function cleanPolicy(raw: unknown): PolicyItem[] {
  const results = raw && typeof raw === "object" ? (raw as {results?:unknown}).results : null;
  if (!Array.isArray(results)) throw new Error("The source returned an unreadable document list.");
  return results.slice(0,8).flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const r = value as Record<string,unknown>;
    const title = text(r.title,400);
    let url: URL;
    try { url = new URL(String(r.html_url)); } catch { return []; }
    if (!title || url.protocol !== "https:" || url.hostname !== "www.federalregister.gov" || url.username || url.password) return [];
    return [{title,url:url.href,publication_date:date(r.publication_date),effective_on:date(r.effective_on),type:text(r.type,80) || "Type not reported",agencies:Array.isArray(r.agencies) ? r.agencies.slice(0,4).map(a => text((a as {name?:unknown})?.name,100)).filter(Boolean) : []}];
  });
}
export async function getPolicy(): Promise<PolicyReport> {
  const now = Date.now();
  if (cached && now-cached.at < (cached.report.problem ? 60_000 : TTL)) return {...cached.report,cached:true};
  if (pending) return pending;
  pending = (async () => {
    const report: PolicyReport = {source:"FederalRegister.gov",checked_at:new Date().toISOString(),items:[],problem:null,cached:false};
    try {
      const response = await fetch(SOURCE,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(6000),redirect:"error"});
      if (!response.ok) throw new Error(`The source returned HTTP ${response.status}.`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The source returned no document data.");
      const chunks: Uint8Array[] = []; let total = 0;
      try {
        while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BYTES) throw new Error("The source response exceeded the document limit.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
      report.items = cleanPolicy(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      report.problem = error instanceof Error ? error.message.slice(0,180) : "The policy source could not be read.";
    }
    cached = {at:Date.now(),report};
    return report;
  })();
  try { return await pending; } finally { pending = null; }
}
