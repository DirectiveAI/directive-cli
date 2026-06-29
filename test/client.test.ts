import { describe, it, expect, vi } from "vitest";
import { DirectiveClient } from "../src/lib/client.js";
import { ApiError } from "../src/lib/errors.js";
import type { Credentials } from "../src/lib/config.js";

const NOW = 10_000; // fixed clock (ms)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function makeClient(creds: Credentials, fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  let saved: Credentials | null = null;
  const client = new DirectiveClient({
    apiBase: "https://api.test",
    now: () => NOW,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    load: () => ({ ...creds }),
    save: (c) => {
      saved = c;
    },
  });
  return { client, getSaved: () => saved };
}

const fresh: Credentials = { access_token: "old", refresh_token: "R", expires_at: NOW + 600_000 };
const expired: Credentials = { access_token: "old", refresh_token: "R", expires_at: 0 };

describe("DirectiveClient", () => {
  it("injects the bearer token and returns parsed JSON", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const { client } = makeClient(fresh, async (url, init) => {
      calls.push({ url, init });
      return json({ user: { email: "a@b.co" }, orgs: [] });
    });
    const me = await client.me();
    expect(me.user.email).toBe("a@b.co");
    expect(calls).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer old");
  });

  it("refreshes proactively when the access token is near expiry", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const { client, getSaved } = makeClient(expired, async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/cli/auth/token")) {
        return json({ access_token: "new", refresh_token: "R2", expires_in: 3600, token_type: "Bearer" });
      }
      return json({ user: { email: "a@b.co" }, orgs: [] });
    });
    await client.me();
    expect(calls[0].url).toContain("/v1/cli/auth/token");
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe("Bearer new");
    expect(getSaved()).toMatchObject({ access_token: "new", refresh_token: "R2", expires_at: NOW + 3600 * 1000 });
  });

  it("refreshes once and retries on a 401", async () => {
    let meCalls = 0;
    const { client } = makeClient(fresh, async (url) => {
      if (url.endsWith("/v1/cli/auth/token")) {
        return json({ access_token: "new2", refresh_token: "R3", expires_in: 3600, token_type: "Bearer" });
      }
      meCalls++;
      return meCalls === 1 ? json({ error: "invalid_token" }, 401) : json({ user: { email: "z@z.co" }, orgs: [] });
    });
    const me = await client.me();
    expect(me.user.email).toBe("z@z.co");
    expect(meCalls).toBe(2);
  });

  it("sends the agent header + JSON body for check-in", async () => {
    let captured: RequestInit | null = null;
    const { client } = makeClient(fresh, async (url, init) => {
      captured = init;
      expect(url).toBe("https://api.test/v1/tasks/check-in");
      return json({ status: "claimed", created: true, task: { id: "t1", title: "T" }, claim: { id: "c1" } });
    });
    const res = await client.checkIn("agent1", { title: "T" });
    expect(res.status).toBe("claimed");
    const headers = captured!.headers as Record<string, string>;
    expect(headers["x-directive-agent-id"]).toBe("agent1");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(captured!.body as string)).toMatchObject({ title: "T" });
  });

  it("throws ApiError on a non-2xx response", async () => {
    const { client } = makeClient(fresh, async () => json({ error: "task_not_found" }, 404));
    await expect(client.heartbeat("a", "t")).rejects.toMatchObject({ status: 404, code: "task_not_found" });
    await expect(client.heartbeat("a", "t")).rejects.toBeInstanceOf(ApiError);
  });

  it("throws not_authenticated when there are no credentials", async () => {
    const client = new DirectiveClient({
      apiBase: "https://api.test",
      load: () => null,
      save: () => {},
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(client.me()).rejects.toMatchObject({ code: "not_authenticated" });
  });
});
