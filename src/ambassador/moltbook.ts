/** Minimal Moltbook API client. Never touches DM, vote, follow, submolt-create or moderation endpoints — by construction. */
const BASE = "https://www.moltbook.com/api/v1";

export class MoltbookError extends Error {
  constructor(public status: number, message: string, public body: unknown) { super(message); }
}

export class Moltbook {
  constructor(private apiKey: string | null) {}

  private async req(method: string, path: string, body?: unknown, auth = true): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "rendezvous-ambassador/0.1 (+https://agentrendezvous.app)" };
    if (auth) { if (!this.apiKey) throw new MoltbookError(0, "no Moltbook API key configured", null); headers.authorization = `Bearer ${this.apiKey}`; }
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    if (!r.ok) throw new MoltbookError(r.status, (data && (data.error || data.message)) || `HTTP ${r.status}`, data);
    return data;
  }

  static register(name: string, description: string) { return new Moltbook(null).req("POST", "/agents/register", { name, description }, false); }
  me() { return this.req("GET", "/agents/me"); }
  status() { return this.req("GET", "/agents/status"); }
  updateProfile(description: string) { return this.req("PATCH", "/agents/me", { description }); }
  home() { return this.req("GET", "/home"); }
  notifications() { return this.req("GET", "/notifications"); }
  markRead(postId: string) { return this.req("POST", `/notifications/read-by-post/${encodeURIComponent(postId)}`); }
  submolts() { return this.req("GET", "/submolts"); }
  submolt(name: string) { return this.req("GET", `/submolts/${encodeURIComponent(name)}`); }
  search(q: string, type: "posts" | "comments" | "all" = "posts", limit = 20) { return this.req("GET", `/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`); }
  post(postId: string) { return this.req("GET", `/posts/${encodeURIComponent(postId)}`); }
  comments(postId: string, sort: "best" | "new" | "old" = "new", limit = 50) { return this.req("GET", `/posts/${encodeURIComponent(postId)}/comments?sort=${sort}&limit=${limit}`); }
  createPost(submolt: string, title: string, content: string) { return this.req("POST", "/posts", { submolt_name: submolt, title, content }); }
  createComment(postId: string, content: string, parentId?: string) { return this.req("POST", `/posts/${encodeURIComponent(postId)}/comments`, parentId ? { content, parent_id: parentId } : { content }); }
  deletePost(postId: string) { return this.req("DELETE", `/posts/${encodeURIComponent(postId)}`); }
  verify(code: string, answer: string) { return this.req("POST", "/verify", { verification_code: code, answer }); }
}
