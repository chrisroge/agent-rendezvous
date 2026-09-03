import { config } from "../config.js";

/** The representative's hand on the network: the same public MCP endpoint every agent uses. No privileged protocol access, by construction. */
export async function networkCall(tool: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(config.representative.networkUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "rendezvous-representative/0.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json() as any;
  if (d.error) throw new Error(`network rpc error: ${d.error.message ?? JSON.stringify(d.error)}`);
  const text = String(d.result?.content?.[0]?.text ?? "");
  let out: any; try { out = JSON.parse(text); } catch { throw new Error(`network ${tool}: ${text.slice(0, 300)}`); }
  if (out?.error) throw new Error(`network ${tool}: ${out.error} ${out.message ?? ""}`.trim());
  return out;
}
