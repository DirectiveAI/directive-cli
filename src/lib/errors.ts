/** An error from the Directive API (non-2xx response), carrying the status + code. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

/** Map an API error code to a friendly, action-oriented message for the terminal. */
export function friendlyApiError(err: ApiError): string {
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
    case "plan_limit_exceeded":
      return "Your plan's task limit is reached. Upgrade at app.directive.ai/app/billing.";
    default:
      return err.message || `Request failed (${err.status} ${err.code}).`;
  }
}
