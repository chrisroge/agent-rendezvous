import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
export { pool };
if (!config.stage) throw new Error('Campaign requires APP_ENV=staging');
export const base = config.publicUrl;
export async function rpc(tool: string, args: Record<string, unknown> = {}, allowError = false): Promise<any> {
 const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}}), signal: AbortSignal.timeout(30000) });
 const d:any = await r.json(); const out = d.result?.structuredContent ?? JSON.parse(d.result?.content?.[0]?.text ?? '{}');
 if ((!r.ok || d.error || out.error) && !allowError) throw new Error(tool + ': ' + JSON.stringify(d.error ?? out));
 return out;
}
export async function admin(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<any> {
 const r = await fetch(base+'/admin'+path,{method, headers:{authorization:'Bearer '+config.operatorToken,'content-type':'application/json'},body: body ? JSON.stringify(body):undefined});
 const d = await r.json(); if (!r.ok) throw new Error(path+': '+JSON.stringify(d)); return d;
}
export async function http(path: string, body?: unknown) {
 const r = await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 return {status:r.status,body:await r.json()};
}
