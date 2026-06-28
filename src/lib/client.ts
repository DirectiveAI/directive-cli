import { ApiError } from "./errors.js";
import { exchangeRefresh } from "./tokens.js";
import { loadCredentials, saveCredentials, type Credentials } from "./config.js";

export const DEFAULT_API_BASE = "https://api.directive.ai";

export interface ClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Current time in ms (injectable for refresh tests). */
  now?: () => number;
  /** Credential store hooks (default: the config files). */
  load?: () => Credentials | null;
  save?: (c: Credentials) => void;
}

interface RequestOptions {
  agentId?: string;
  body?: unknown;
}

// Refresh a little early so a request never rides an already-expired token.
const REFRESH_SKEW_MS = 60_000;

/**
 * Thin REST client for the Directive API. Injects the bearer token (and the
 * `X-Directive-Agent-Id` header for task calls), transparently refreshes the
 * access token when it's near expiry or a call returns 401, and persists the
 * rotated tokens. This is the shared core the commands (and, later, an MCP
 * server / SDK) build on.
 */
export class DirectiveClient {
  private apiBase: string;
  private fetchImpl: typeof fetch;
  private now: () => number;
  private load: () => Credentials | null;
  private save: (c: Credentials) => void;
  private creds: Credentials | null;

  constructor(opts: ClientOptions = {}) {
    this.apiBase = opts.apiBase ?? process.env.DIRECTIVE_API_BASE ?? DEFAULT_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => Date.now());
    this.load = opts.load ?? (() => loadCredentials());
    this.save = opts.save ?? ((c) => saveCredentials(c));
    this.creds = this.load();
  }

  isAuthenticated(): boolean {
    return this.creds !== null;
  }

  email(): string | undefined {
    return this.creds?.email ?? undefined;
  }

  agentId(): string | undefined {
    return this.creds?.agent_id ?? undefined;
  }

  /** Persist the default agent id onto the stored credentials. */
  setAgentId(agentId: string): void {
    if (!this.creds) throw new ApiError(401, "not_authenticated");
    this.creds = { ...this.creds, agent_id: agentId };
    this.save(this.creds);
  }

  private async accessToken(): Promise<string> {
    if (!this.creds) throw new ApiError(401, "not_authenticated");
    if (this.creds.expires_at - REFRESH_SKEW_MS <= this.now()) await this.refresh();
    return this.creds.access_token;
  }

  private async refresh(): Promise<void> {
    if (!this.creds) throw new ApiError(401, "not_authenticated");
    const set = await exchangeRefresh(this.apiBase, this.fetchImpl, this.creds.refresh_token);
    this.creds = {
      ...this.creds,
      access_token: set.access_token,
      refresh_token: set.refresh_token,
      expires_at: this.now() + set.expires_in * 1000,
    };
    this.save(this.creds);
  }

  private call(method: string, path: string, token: string, opts: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.agentId) headers["x-directive-agent-id"] = opts.agentId;
    return this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const token = await this.accessToken();
    let res = await this.call(method, path, token, opts);
    // One reactive refresh on 401 (e.g. the token was revoked server-side).
    if (res.status === 401 && this.creds) {
      await this.refresh();
      res = await this.call(method, path, this.creds.access_token, opts);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Keep any extra body fields (e.g. subscription `status`, plan-limit `meter`)
      // as `detail` so callers can render a precise message / exit code.
      const { error, message, ...detail } = json;
      throw new ApiError(res.status, (error as string) ?? `http_${res.status}`, message as string | undefined, detail);
    }
    return json as T;
  }

  // ── Typed endpoints ──────────────────────────────────────────────────────
  me(): Promise<{ user: { id: string; email: string | null; name: string | null }; orgs: OrgSummary[] }> {
    return this.request("GET", "/v1/me");
  }

  listAgents(orgId: string): Promise<{ agents: AgentSummary[] }> {
    return this.request("GET", `/v1/orgs/${orgId}/agents`);
  }

  createAgent(orgId: string, name: string): Promise<{ agent: AgentSummary }> {
    return this.request("POST", `/v1/orgs/${orgId}/agents`, { body: { name } });
  }

  checkIn(agentId: string, body: CheckInBody): Promise<CheckInResult> {
    return this.request("POST", "/v1/tasks/check-in", { agentId, body });
  }

  heartbeat(agentId: string, taskId: string): Promise<{ claim: unknown }> {
    return this.request("POST", `/v1/tasks/${taskId}/heartbeat`, { agentId });
  }

  report(agentId: string, taskId: string, status: ReportStatus, note?: string): Promise<{ task: TaskSummary }> {
    return this.request("POST", `/v1/tasks/${taskId}/report`, { agentId, body: { status, note } });
  }

  reportUsage(agentId: string, taskId: string, usage: UsageBody): Promise<{ usage: unknown }> {
    return this.request("POST", `/v1/tasks/${taskId}/usage`, { agentId, body: usage });
  }
}

export interface OrgSummary {
  id: string;
  name: string | null;
  slug: string;
  role: string;
  subscription: { plan: string | null; status: string } | null;
}

export interface AgentSummary {
  id: string;
  org_id: string;
  user_id: string | null;
  name: string;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
}

export interface CheckInBody {
  title: string;
  description?: string;
  tracker?: "github" | "jira" | "productboard" | "other";
  external_id?: string;
  external_url?: string;
  dedup_key?: string;
}

export interface CheckInResult {
  status: "claimed" | "already_claimed";
  created: boolean;
  task: TaskSummary;
  claim: { id: string } | null;
}

export type ReportStatus = "completed" | "blocked" | "abandoned" | "released";

export interface UsageBody {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_micro_usd?: number;
}
