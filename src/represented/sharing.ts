/** Only exact facts explicitly selected by the human may enter an investigation. New facts default private. */
export function sharedFacts(facts: unknown): { topic: string; fact: string; provenance: string }[] {
  if (!Array.isArray(facts)) return [];
  return facts.filter(f => f?.share === true && typeof f.fact === 'string').map(f => ({ topic: String(f.topic ?? ''), fact: f.fact, provenance: String(f.provenance ?? 'UNKNOWN') }));
}
