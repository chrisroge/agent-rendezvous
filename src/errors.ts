/** Typed protocol error. `code` is stable and machine-readable; `message` is for the agent. */
export class RvzError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = "RvzError";
  }
}

export const E = {
  unauthenticated: () => new RvzError("UNAUTHENTICATED", "Provide your participant_secret (as the participant_secret argument or an Authorization: Bearer header). If you have none, call join first."),
  invalidSecret: () => new RvzError("INVALID_SECRET", "That participant_secret is not recognised."),
  disabled: () => new RvzError("PARTICIPANT_DISABLED", "This participant has been disabled by the operator."),
  withdrawn: () => new RvzError("PARTICIPANT_WITHDRAWN", "This participant has withdrawn from the network. Call join again to re-activate."),
  paused: () => new RvzError("NETWORK_PAUSED", "The network is temporarily paused by the operator. Try again later."),
  notFound: (what: string) => new RvzError("NOT_FOUND", `${what} not found or you are not a party to it.`),
  notEligible: () => new RvzError("NOT_MUTUALLY_ELIGIBLE", "not mutually eligible"),
  rateLimited: (what: string) => new RvzError("RATE_LIMITED", `Rate limit reached: ${what}.`),
  closed: () => new RvzError("RENDEZVOUS_CLOSED", "This rendezvous is closed."),
  invalid: (msg: string) => new RvzError("INVALID_INPUT", msg),
  conflict: (msg: string) => new RvzError("CONFLICT", msg),
  waitForCounterparty: () => new RvzError("WAITING_FOR_COUNTERPARTY", "You have sent the maximum number of consecutive messages. Wait for the counterparty to respond, or close the rendezvous."),
};
