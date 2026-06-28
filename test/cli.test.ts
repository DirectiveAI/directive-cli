import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run, VERSION, type RunOverrides } from "../src/cli.js";
import { ApiError } from "../src/lib/errors.js";
import type { DirectiveClient } from "../src/lib/client.js";
import { loadActiveTask, loadCredentials } from "../src/lib/config.js";
import type { ChildLike, SpawnLike } from "../src/commands/start.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "directive-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) }, out, err };
}

/** A fake spawned child whose `exit` can be fired on demand. */
function fakeChild() {
  const handlers: Record<string, (arg: number) => void> = {};
  const child = {
    on(event: string, cb: (arg: number) => void) {
      handlers[event] = cb;
    },
  };
  return { child: child as unknown as ChildLike, fireExit: (code: number) => handlers.exit(code) };
}

/** A fake client; only the methods a command touches need to behave. */
function fakeClient(over: Partial<Record<keyof DirectiveClient, unknown>> = {}): DirectiveClient {
  const base = {
    isAuthenticated: () => true,
    agentId: () => "A1",
    email: () => "a@b.co",
    setAgentId: vi.fn(),
    me: vi.fn(async () => ({
      user: { id: "u", email: "a@b.co", name: null },
      orgs: [{ id: "o1", name: "Org", slug: "o1", role: "owner", subscription: null }],
    })),
    listAgents: vi.fn(async () => ({ agents: [] })),
    createAgent: vi.fn(async () => ({ agent: { id: "newA", org_id: "o1", user_id: "u", name: "bot" } })),
    checkIn: vi.fn(async () => ({
      status: "claimed",
      created: true,
      task: { id: "t1", title: "T", status: "in_progress" },
      claim: { id: "c1" },
    })),
    heartbeat: vi.fn(async () => ({ claim: {} })),
    report: vi.fn(async () => ({ task: { id: "t1", title: "T", status: "completed" } })),
    reportUsage: vi.fn(async () => ({ usage: {} })),
  };
  return { ...base, ...over } as unknown as DirectiveClient;
}

const opts = (client: DirectiveClient, io: RunOverrides["io"], extra: Partial<RunOverrides> = {}): RunOverrides => ({
  io,
  makeClient: () => client,
  configDir: dir,
  env: {},
  ...extra,
});

describe("parseArgs", () => {
  it("reads flags, values, and positionals", () => {
    const a = parseArgs(["check-in", "--title", "Fix bug", "--tracker", "github"]);
    expect(a.command).toBe("check-in");
    expect(a.flags).toEqual({ title: "Fix bug", tracker: "github" });
  });
  it("supports --flag=value and boolean flags", () => {
    const a = parseArgs(["report", "--status=completed", "--force"]);
    expect(a.flags).toEqual({ status: "completed", force: true });
  });
  it("splits the wrapped command after --", () => {
    const a = parseArgs(["start", "--title", "x", "--", "npm", "test"]);
    expect(a.command).toBe("start");
    expect(a.flags.title).toBe("x");
    expect(a.rest).toEqual(["npm", "test"]);
  });
});

describe("run — meta", () => {
  it("prints the version", async () => {
    const { io, out } = captureIO();
    expect(await run(["--version"], { io })).toBe(0);
    expect(out).toEqual([VERSION]);
  });
  it("prints help for an unknown command (usage, exit 2)", async () => {
    const { io, err } = captureIO();
    expect(await run(["frobnicate"], opts(fakeClient(), io))).toBe(2);
    expect(err[0]).toMatch(/unknown command/i);
  });
});

describe("run — auth", () => {
  it("whoami prints the account + orgs", async () => {
    const { io, out } = captureIO();
    expect(await run(["whoami"], opts(fakeClient(), io))).toBe(0);
    expect(out.join("\n")).toMatch(/a@b\.co/);
    expect(out.join("\n")).toMatch(/o1/);
  });
  it("whoami fails cleanly when logged out (auth, exit 3)", async () => {
    const { io, err } = captureIO();
    expect(await run(["whoami"], opts(fakeClient({ isAuthenticated: () => false }), io))).toBe(3);
    expect(err.join("\n")).toMatch(/not logged in/i);
  });
  it("logout reports success", async () => {
    const { io, out } = captureIO();
    expect(await run(["logout"], opts(fakeClient(), io))).toBe(0);
    expect(out.join("\n")).toMatch(/logged out/i);
  });
});

describe("run — agents", () => {
  it("agent create registers and sets the default", async () => {
    const { io, out } = captureIO();
    const c = fakeClient();
    expect(await run(["agent", "create", "--org", "o1", "--name", "bot"], opts(c, io))).toBe(0);
    expect(c.createAgent).toHaveBeenCalledWith("o1", "bot");
    expect(c.setAgentId).toHaveBeenCalledWith("newA");
    expect(out.join("\n")).toMatch(/newA/);
  });
  it("agent create requires --org (usage, exit 2)", async () => {
    const { io, err } = captureIO();
    expect(await run(["agent", "create", "--name", "bot"], opts(fakeClient(), io))).toBe(2);
    expect(err.join("\n")).toMatch(/--org/);
  });
});

describe("run — coordination loop", () => {
  it("check-in claims and records the active task", async () => {
    const { io, out } = captureIO();
    const c = fakeClient();
    expect(await run(["check-in", "--title", "Fix the bug", "--tracker", "github"], opts(c, io))).toBe(0);
    expect(c.checkIn).toHaveBeenCalledWith("A1", expect.objectContaining({ title: "Fix the bug", tracker: "github" }));
    expect(loadActiveTask(dir)).toMatchObject({ task_id: "t1" });
    expect(out.join("\n")).toMatch(/claimed t1/i);
  });

  it("check-in returns code 4 when another agent holds it", async () => {
    const { io } = captureIO();
    const c = fakeClient({
      checkIn: vi.fn(async () => ({
        status: "already_claimed",
        created: false,
        task: { id: "t9", title: "X", status: "in_progress" },
        claim: null,
      })),
    });
    expect(await run(["check-in", "--title", "X"], opts(c, io))).toBe(4);
  });

  it("check-in requires --title (usage, exit 2)", async () => {
    const { io, err } = captureIO();
    expect(await run(["check-in"], opts(fakeClient(), io))).toBe(2);
    expect(err.join("\n")).toMatch(/--title/);
  });

  it("report uses --task and clears the active task on a terminal status", async () => {
    const { io } = captureIO();
    const c = fakeClient();
    await run(["check-in", "--title", "T"], opts(c, io)); // sets active task t1
    expect(loadActiveTask(dir)).not.toBeNull();
    expect(await run(["report", "--status", "completed", "--task", "t1"], opts(c, io))).toBe(0);
    expect(c.report).toHaveBeenCalledWith("A1", "t1", "completed", undefined);
    expect(loadActiveTask(dir)).toBeNull();
  });

  it("report rejects an invalid status (usage, exit 2)", async () => {
    const { io, err } = captureIO();
    expect(await run(["report", "--status", "nope", "--task", "t1"], opts(fakeClient(), io))).toBe(2);
    expect(err.join("\n")).toMatch(/--status/);
  });

  it("task commands fail clearly when no agent is configured (usage, exit 2)", async () => {
    const { io, err } = captureIO();
    const c = fakeClient({ agentId: () => undefined });
    expect(await run(["heartbeat", "--task", "t1"], opts(c, io))).toBe(2);
    expect(err.join("\n")).toMatch(/no agent configured/i);
  });

  it("surfaces a friendly API error and maps it to an exit code (not found, exit 5)", async () => {
    const { io, err } = captureIO();
    const c = fakeClient({
      heartbeat: vi.fn(async () => {
        throw new ApiError(404, "no_active_claim");
      }),
    });
    expect(await run(["heartbeat", "--task", "t1"], opts(c, io))).toBe(5);
    expect(err.join("\n")).toMatch(/no active claim/i);
  });
});

describe("run — start (wrapper)", () => {
  it("checks in, runs the command, then reports completed on exit 0", async () => {
    const { io, out } = captureIO();
    const c = fakeClient();
    const { child, fireExit } = fakeChild();
    const spawnImpl: SpawnLike = (cmd, args) => {
      expect(cmd).toBe("echo");
      expect(args).toEqual(["hi"]);
      queueMicrotask(() => fireExit(0));
      return child;
    };
    const code = await run(["start", "--title", "Wrapped", "--", "echo", "hi"], opts(c, io, { spawnImpl }));
    expect(code).toBe(0);
    expect(c.checkIn).toHaveBeenCalled();
    expect(c.report).toHaveBeenCalledWith("A1", "t1", "completed", "exit 0");
    expect(loadActiveTask(dir)).toBeNull();
    expect(out.join("\n")).toMatch(/reported completed/i);
  });

  it("reports abandoned on a non-zero exit and propagates the code", async () => {
    const { io } = captureIO();
    const c = fakeClient();
    const { child, fireExit } = fakeChild();
    const spawnImpl: SpawnLike = () => {
      queueMicrotask(() => fireExit(2));
      return child;
    };
    const code = await run(["start", "--title", "W", "--", "false"], opts(c, io, { spawnImpl }));
    expect(code).toBe(2);
    expect(c.report).toHaveBeenCalledWith("A1", "t1", "abandoned", "exit 2");
  });
});

describe("run — billing / 402 handling", () => {
  const subRequired = () =>
    fakeClient({
      checkIn: vi.fn(async () => {
        throw new ApiError(402, "subscription_required", undefined, { status: "free" });
      }),
    });

  it("maps 402 subscription_required to exit 7 with a trial + billing message", async () => {
    const { io, err } = captureIO();
    expect(await run(["check-in", "--title", "X"], opts(subRequired(), io))).toBe(7);
    const msg = err.join("\n");
    expect(msg).toMatch(/no active Directive subscription \(status: free\)/);
    expect(msg).toMatch(/free 14-day trial/);
    expect(msg).toMatch(/https:\/\/app\.directive\.ai\/billing/);
  });

  it("subscription_required --json emits { error, message, status } on stdout", async () => {
    const { io, out } = captureIO();
    expect(await run(["check-in", "--title", "X", "--json"], opts(subRequired(), io))).toBe(7);
    expect(out).toHaveLength(1);
    const data = JSON.parse(out[0]);
    expect(data).toMatchObject({ error: "subscription_required", status: "free" });
    expect(data.message).toMatch(/billing/);
  });

  it("honors DIRECTIVE_APP_BASE for the billing link", async () => {
    const { io, err } = captureIO();
    const code = await run(
      ["check-in", "--title", "X"],
      opts(subRequired(), io, { env: { DIRECTIVE_APP_BASE: "https://staging.directive.ai" } }),
    );
    expect(code).toBe(7);
    expect(err.join("\n")).toMatch(/https:\/\/staging\.directive\.ai\/billing/);
  });

  it("keeps plan_limit_exceeded on exit 6 (distinct from subscription_required)", async () => {
    const { io, err } = captureIO();
    const c = fakeClient({
      checkIn: vi.fn(async () => {
        throw new ApiError(402, "plan_limit_exceeded", undefined, { meter: "tasks", used: 100, limit: 100 });
      }),
    });
    expect(await run(["check-in", "--title", "X"], opts(c, io))).toBe(6);
    expect(err.join("\n")).toMatch(/limit is reached \(tasks: 100\/100\)/);
  });

  it("start aborts before running the wrapped command on subscription_required (exit 7)", async () => {
    const { io } = captureIO();
    const c = subRequired();
    const spawnImpl = vi.fn<SpawnLike>(() => {
      throw new Error("the wrapped command must not run when check-in is paywalled");
    });
    const code = await run(["start", "--title", "X", "--", "echo", "hi"], opts(c, io, { spawnImpl }));
    expect(code).toBe(7);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(c.report).not.toHaveBeenCalled();
    expect(loadActiveTask(dir)).toBeNull();
  });
});

describe("run — --json output", () => {
  it("emits exactly one JSON object on stdout (human lines go to stderr)", async () => {
    const { io, out, err } = captureIO();
    expect(await run(["whoami", "--json"], opts(fakeClient(), io))).toBe(0);
    expect(out).toHaveLength(1);
    const data = JSON.parse(out[0]);
    expect(data.user.email).toBe("a@b.co");
    expect(data.orgs).toHaveLength(1);
    // Human rendering still happens, but on stderr — stdout stays parseable.
    expect(err.join("\n")).toMatch(/a@b\.co/);
  });

  it("check-in --json reports the claim as structured data", async () => {
    const { io, out } = captureIO();
    expect(await run(["check-in", "--title", "Fix", "--json"], opts(fakeClient(), io))).toBe(0);
    expect(JSON.parse(out[0])).toMatchObject({ status: "claimed", task: { id: "t1" } });
  });

  it("already-claimed --json keeps exit 4 with a structured body", async () => {
    const { io, out } = captureIO();
    const c = fakeClient({
      checkIn: vi.fn(async () => ({
        status: "already_claimed",
        created: false,
        task: { id: "t9", title: "X", status: "in_progress" },
        claim: null,
      })),
    });
    expect(await run(["check-in", "--title", "X", "--json"], opts(c, io))).toBe(4);
    expect(JSON.parse(out[0])).toMatchObject({ status: "already_claimed", task: { id: "t9" } });
  });

  it("renders errors as a JSON object on stdout", async () => {
    const { io, out } = captureIO();
    const code = await run(["whoami", "--json"], opts(fakeClient({ isAuthenticated: () => false }), io));
    expect(code).toBe(3);
    expect(JSON.parse(out[0])).toMatchObject({ error: "not_authenticated" });
  });

  it("--json before the command still resolves the command (boolean flag)", async () => {
    const a = parseArgs(["--json", "whoami"]);
    expect(a.command).toBe("whoami");
    expect(a.flags.json).toBe(true);
  });
});

describe("run — headless env credentials", () => {
  const jsonRes = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("authenticates from DIRECTIVE_TOKEN without a token file", async () => {
    const { io, out } = captureIO();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/v1/me")) {
        return jsonRes({ user: { id: "u", email: "ci@acme.co", name: null }, orgs: [] });
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    });
    const code = await run(["whoami"], {
      io,
      configDir: dir,
      env: { DIRECTIVE_TOKEN: "env-access-token" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/ci@acme\.co/);
    // Nothing is persisted to disk in env mode.
    expect(loadCredentials(dir)).toBeNull();
  });

  it("mints a fresh access token per run from DIRECTIVE_REFRESH_TOKEN", async () => {
    const { io } = captureIO();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/v1/cli/auth/token")) {
        return jsonRes({ access_token: "fresh", refresh_token: "rot", expires_in: 3600, token_type: "Bearer" });
      }
      if (u.endsWith("/v1/me")) return jsonRes({ user: { id: "u", email: "ci@acme.co", name: null }, orgs: [] });
      throw new Error(`unexpected fetch: ${u}`);
    });
    const code = await run(["whoami"], {
      io,
      configDir: dir,
      env: { DIRECTIVE_REFRESH_TOKEN: "long-lived-secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    // The refresh endpoint is hit before /v1/me (expires_at forced to 0).
    expect(calls.some((u) => u.endsWith("/v1/cli/auth/token"))).toBe(true);
    expect(loadCredentials(dir)).toBeNull();
  });
});
