/** June's hand on the Rendezvous network: the same public MCP endpoint every agent uses. No privileged access, by construction. */
const NETWORK = process.env.JUNE_NETWORK_URL ?? "https://agentrendezvous.app/mcp";

export async function networkCall(tool: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(NETWORK, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "june-matchmaker/0.1 (+https://june.agentrendezvous.app)" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  const d = await r.json() as any;
  if (d.error) throw new Error(`network rpc error: ${d.error.message ?? JSON.stringify(d.error)}`);
  const out = JSON.parse(d.result.content[0].text);
  return out;
}
