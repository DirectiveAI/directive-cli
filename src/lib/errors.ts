/**
 * An error from the Directive API (non-2xx response), carrying the HTTP status,
 * the server's error `code`, and any extra body fields (`detail`) — e.g. the
 * subscription `status` on a 402, or the `meter`/`used`/`limit` on a plan-limit hit.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

/**
 * Map an API error code to a friendly, action-oriented message for the terminal.
 * `appBase` (honoring `DIRECTIVE_APP_BASE`) builds the billing URL so the link
 * matches the environment the CLI is pointed at.
 */
export function friendlyApiError(err: ApiError, appBase: string): string {
  const billingUrl = new URL("/billing", appBase).toString();
  switch (err.code) {
    case "not_authenticated":
    case "unauthenticated":
    case "invalid_token":
      return "You're not logged in. Run `directive login`.";
    case "account_not_provisioned":
      return "Your account isn't set up yet — finish sign-up at app.directive.ai first.";
    case "missing_agent":
    case "unknown_agent":
    case "agent_not_owned":
    case "not_a_member":
      return "This agent isn't usable. Pass --agent <id>, set DIRECTIVE_AGENT_ID, or run `directive agent create`.";
    case "no_active_claim":
      return "No active claim for that task held by this agent.";
    case "task_not_found":
      return "That task wasn't found in this org.";
    case "subscription_required": {
      const status = typeof err.detail.status === "string" ? err.detail.status : "none";
      return (
        `This organization has no active Directive subscription (status: ${status}), so coordination is paused. ` +
        `An org owner needs to start a plan — there's a free 14-day trial — at ${billingUrl}. Once that's done, retry.`
      );
    }
    case "plan_limit_exceeded": {
      const { meter, used, limit } = err.detail;
      const detail = meter ? ` (${meter}: ${used}/${limit})` : "";
      return `Your plan's task limit is reached${detail}. Raise it or upgrade at ${billingUrl}.`;
    }
    default:
      return err.message || `Request failed (${err.status} ${err.code}).`;
  }
}
