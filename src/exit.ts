import { ApiError } from "./lib/errors.js";

/**
 * The CLI's stable exit-code contract, so scripts and agents can branch on the
 * outcome without parsing prose. Documented in the README + the skill reference.
 *
 *   0  ok
 *   1  unexpected / runtime error (network, unknown server error)
 *   2  usage error (missing or invalid flags, unknown command)
 *   3  auth required (not logged in, token invalid/expired, account not provisioned)
 *   4  already claimed by another agent (check-in / start)
 *   5  not found (task, agent, or active claim)
 *   6  plan limit reached (a meter cap on an active plan)
 *   7  subscription required (the org has no active plan or trial)
 *
 * `start`/`run` instead propagate the wrapped command's own exit code (and 127 if
 * it isn't executable); the codes above only apply to its own check-in/report step.
 */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  ALREADY_CLAIMED: 4,
  NOT_FOUND: 5,
  PLAN_LIMIT: 6,
  SUBSCRIPTION_REQUIRED: 7,
} as const;

/** Map an API error to the exit code that best describes it (see EXIT). */
export function exitCodeForApiError(err: ApiError): number {
  switch (err.code) {
    case "not_authenticated":
    case "unauthenticated":
    case "invalid_token":
    case "account_not_provisioned":
      return EXIT.AUTH;
    case "missing_agent":
    case "unknown_agent":
    case "agent_not_owned":
    case "not_a_member":
    case "not_a_project_member":
      return EXIT.USAGE;
    case "task_not_found":
    case "project_not_found":
    case "no_active_claim":
      return EXIT.NOT_FOUND;
    case "plan_limit_exceeded":
      return EXIT.PLAN_LIMIT;
    case "subscription_required":
      return EXIT.SUBSCRIPTION_REQUIRED;
    default:
      return EXIT.ERROR;
  }
}
