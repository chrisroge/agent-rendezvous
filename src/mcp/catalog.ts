import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./server.js";

export interface ToolEntry { name: string; description: string; inputSchema: Record<string, unknown> }
let cached: ToolEntry[] | null = null;

/** The live tool catalog, read from the real server over an in-memory transport so discovery documents never drift from the code. */
export async function toolCatalog(): Promise<ToolEntry[]> {
  if (cached) return cached;
  const server = createMcpServer({ ip: undefined, userAgent: "catalog", bearer: undefined });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "catalog", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  const { tools } = await client.listTools();
  cached = tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> }));
  await client.close().catch(() => {}); await server.close().catch(() => {});
  return cached;
}
