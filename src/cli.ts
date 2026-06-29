import { consoleIO, errorMessage, type IO } from "./io.js";
import { makeOutput, type Output } from "./output.js";
import { EXIT, exitCodeForApiError } from "./exit.js";
import { ApiError, friendlyApiError } from "./lib/errors.js";
import {
  DEFAULT_API_BASE,
  DirectiveClient,
  type CheckInBody,
  type ReportStatus,
  type UsageBody,
} from "./lib/client.js";
import { configDir, credentialsFromEnv, loadCredentials, saveCredentials } from "./lib/config.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runWhoami } from "./commands/whoami.js";
import { runAgentCreate, runAgentList } from "./commands/agent.js";
import { runProjectCreate, runProjectList, runProjectUse } from "./commands/project.js";
import { runCheckIn, runHeartbeat, runReport, runUsage } from "./commands/tasks.js";
import { runStart, type SpawnLike } from "./commands/start.js";

export const VERSION = "0.0.4";

/** Canonical command + alias names the CLI dispatches (the skill is validated against this). */
export const COMMANDS = [
  "login",
  "logout",
  "whoami",
  "agent",
  "project",
  "check-in",
  "checkin",
  "heartbeat",
  "report",
  "usage",
  "start",
  "run",
  "help",
  "version",
] as const;

const DEFAULT_APP_BASE = "https://app.directive.ai";
const REPORT_STATUSES: ReportStatus[] = ["completed", "blocked", "abandoned", "released"];

// Flags that never take a value (so the parser doesn't swallow the next token as
// their value — e.g. `directive --json whoami` must keep `whoami` as the command).
const BOOLEAN_FLAGS = new Set(["json", "help", "version", "headless"]);

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Tokens after a `--` separator (the wrapped command for `start`). */
  rest: string[];
}

/**
 * Tiny zero-dependency argv parser. Splits a trailing `-- …` as `rest`, then reads
 * `--flag value` / `--flag=value` / boolean `--flag`; everything else is positional.
 * Known boolean flags (see BOOLEAN_FLAGS) never consume the following token.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const dd = argv.indexOf("--");
  const rest = dd >= 0 ? argv.slice(dd + 1) : [];
  const main = dd >= 0 ? argv.slice(0, dd) : argv;

  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < main.length; i++) {
    const a = main[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = main[i + 1];
        if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { command: positionals[0] ?? "help", positionals: positionals.slice(1), flags, rest };
}

const HELP = `directive — coordinate AI agents from the terminal

Usage: directive <command> [options]

Auth
  login [--headless]          Sign in via your browser (OAuth + PKCE).
                              --headless uses a device code (CI / no browser).
  logout                      Forget the stored tokens
  whoami                      Show the account, its orgs, and the active task

Agents
  agent create --org <id> --name <name>   Register an agent (becomes the default)
  agent list --org <id>                    List an org's agents

Projects
  project list --org <id>                  List the projects you belong to
  project create --org <id> --name <name> [--slug <s>] [--description <d>]
                                           Create a project (sets it as current)
  project use <id>                         Set the current project for check-ins

Coordination loop
  check-in --project <id> --title <t> [--tracker <github|jira|productboard|other>]
           [--external-id <id>] [--external-url <url>] [--description <d>]
           [--dedup-key <k>]               Claim a task (dedup). A project is
                                           required: --project, DIRECTIVE_PROJECT_ID,
                                           or 'project use'.
  heartbeat [--task <id>]                  Keep the active claim alive
  report --status <completed|blocked|abandoned|released> [--task <id>] [--note <n>]
  usage --input <n> --output <n> [--model <m>] [--cost <micro_usd>] [--task <id>]
  start --project <id> --title <t> [check-in opts] -- <command…>
                                           Check in, heartbeat while the command
                                           runs, then report completed/abandoned

Global
  --agent <id>                Act as this agent (or set DIRECTIVE_AGENT_ID)
  --project <id>              Check in to this project (or set DIRECTIVE_PROJECT_ID)
  --json                      Emit one machine-readable JSON object on stdout
  --version, --help

Headless auth
  Set DIRECTIVE_REFRESH_TOKEN (recommended) or DIRECTIVE_TOKEN to authenticate
  from a secret with no interactive login. See \`directive login --headless\`.

Exit codes
  0 ok · 1 error · 2 usage · 3 auth required · 4 already claimed · 5 not found ·
  6 plan limit · 7 subscription required  (start/run propagate the wrapped command's code)`;

export interface RunOverrides {
  io?: IO;
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  apiBase?: string;
  appBase?: string;
  makeClient?: () => DirectiveClient;
  openBrowser?: (url: string) => void;
  fetchImpl?: typeof fetch;
  port?: number;
  spawnImpl?: SpawnLike;
  /** Injectable timers for the headless device-login poll loop (tests). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: string | boolean | undefined): number | undefined => {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

type AgentResolution = { ok: true; agentId: string } | { ok: false; code: number };

function resolveAgent(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  client: DirectiveClient,
  out: Output,
): AgentResolution {
  if (!client.isAuthenticated()) {
    out.fail("Not logged in. Run `directive login`.", { code: "not_authenticated" });
    return { ok: false, code: EXIT.AUTH };
  }
  const id = str(flags.agent) ?? env.DIRECTIVE_AGENT_ID ?? client.agentId();
  if (!id) {
    out.fail("No agent configured. Pass --agent <id>, set DIRECTIVE_AGENT_ID, or run `directive agent create`.", {
      code: "missing_agent",
    });
    return { ok: false, code: EXIT.USAGE };
  }
  return { ok: true, agentId: id };
}

type ProjectResolution = { ok: true; projectId: string } | { ok: false; code: number };

/** Resolve the project to check in to: --project, else $DIRECTIVE_PROJECT_ID, else the current project. */
function resolveProject(
  flags: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv,
  client: DirectiveClient,
  out: Output,
): ProjectResolution {
  const id = str(flags.project) ?? env.DIRECTIVE_PROJECT_ID ?? client.projectId();
  if (!id) {
    out.fail(
      "No project selected. Pass --project <id>, set DIRECTIVE_PROJECT_ID, or run `directive project use <id>`.",
      { code: "missing_project" },
    );
    return { ok: false, code: EXIT.USAGE };
  }
  return { ok: true, projectId: id };
}

function checkInBody(flags: Record<string, string | boolean>, projectId: string, out: Output): CheckInBody | null {
  const title = str(flags.title);
  if (!title) {
    out.fail("Missing --title <text>.", { code: "usage" });
    return null;
  }
  return {
    project_id: projectId,
    title,
    description: str(flags.description),
    tracker: str(flags.tracker) as CheckInBody["tracker"],
    external_id: str(flags["external-id"]),
    external_url: str(flags["external-url"]),
    dedup_key: str(flags["dedup-key"]),
  };
}

function usageBody(flags: Record<string, string | boolean>): UsageBody {
  return {
    model: str(flags.model),
    input_tokens: num(flags.input),
    output_tokens: num(flags.output),
    cost_micro_usd: num(flags.cost),
  };
}

/** Parse argv and run a command. Returns the process exit code. */
export async function run(argv: string[], overrides: RunOverrides = {}): Promise<number> {
  const io = overrides.io ?? consoleIO;
  const env = overrides.env ?? process.env;
  const args = parseArgs(argv);
  const out = makeOutput(io, args.flags.json === true);

  if (args.flags.version || args.command === "version") {
    out.say(VERSION);
    out.result({ version: VERSION });
    return EXIT.OK;
  }
  if (args.command === "help" || args.flags.help) {
    out.say(HELP);
    return EXIT.OK;
  }

  const apiBase = overrides.apiBase ?? env.DIRECTIVE_API_BASE ?? DEFAULT_API_BASE;
  const appBase = overrides.appBase ?? env.DIRECTIVE_APP_BASE ?? DEFAULT_APP_BASE;
  const dir = overrides.configDir ?? configDir(env);
  // Headless / CI: credentials supplied via env take precedence over the on-disk
  // store, and the rotated tokens are kept in memory (never written to a file).
  const envCreds = credentialsFromEnv(env);
  const makeClient =
    overrides.makeClient ??
    (() =>
      new DirectiveClient({
        apiBase,
        fetchImpl: overrides.fetchImpl,
        load: () => envCreds ?? loadCredentials(dir),
        save: envCreds ? () => {} : (c) => saveCredentials(c, dir),
      }));

  try {
    switch (args.command) {
      case "login":
        return await runLogin({
          apiBase,
          appBase,
          out,
          configDir: dir,
          headless: args.flags.headless === true,
          openBrowser: overrides.openBrowser,
          fetchImpl: overrides.fetchImpl,
          port: overrides.port,
          sleep: overrides.sleep,
          now: overrides.now,
        });

      case "logout":
        return runLogout({ out, configDir: dir });

      case "whoami":
        return await runWhoami({ client: makeClient(), out, configDir: dir });

      case "agent": {
        const sub = args.positionals[0] ?? "list";
        const client = makeClient();
        if (sub === "create") {
          return await runAgentCreate({ client, out, orgId: str(args.flags.org), name: str(args.flags.name) });
        }
        if (sub === "list") return await runAgentList({ client, out, orgId: str(args.flags.org) });
        out.fail(`Unknown agent subcommand: ${sub}`, { code: "usage" });
        return EXIT.USAGE;
      }

      case "project": {
        const sub = args.positionals[0] ?? "list";
        const client = makeClient();
        if (!client.isAuthenticated()) {
          out.fail("Not logged in. Run `directive login`.", { code: "not_authenticated" });
          return EXIT.AUTH;
        }
        if (sub === "create") {
          return await runProjectCreate({
            client,
            out,
            orgId: str(args.flags.org),
            name: str(args.flags.name),
            slug: str(args.flags.slug),
            description: str(args.flags.description),
          });
        }
        if (sub === "list") return await runProjectList({ client, out, orgId: str(args.flags.org) });
        if (sub === "use") return runProjectUse({ client, out, projectId: args.positionals[1] });
        out.fail(`Unknown project subcommand: ${sub}`, { code: "usage" });
        return EXIT.USAGE;
      }

      case "checkin":
      case "check-in": {
        const client = makeClient();
        const agent = resolveAgent(args.flags, env, client, out);
        if (!agent.ok) return agent.code;
        const project = resolveProject(args.flags, env, client, out);
        if (!project.ok) return project.code;
        const body = checkInBody(args.flags, project.projectId, out);
        if (!body) return EXIT.USAGE;
        return await runCheckIn({ client, out, configDir: dir, agentId: agent.agentId, body });
      }

      case "heartbeat": {
        const client = makeClient();
        const agent = resolveAgent(args.flags, env, client, out);
        if (!agent.ok) return agent.code;
        return await runHeartbeat({
          client,
          out,
          configDir: dir,
          agentId: agent.agentId,
          taskId: str(args.flags.task),
        });
      }

      case "report": {
        const client = makeClient();
        const agent = resolveAgent(args.flags, env, client, out);
        if (!agent.ok) return agent.code;
        const status = str(args.flags.status) as ReportStatus | undefined;
        if (!status || !REPORT_STATUSES.includes(status)) {
          out.fail(`Pass --status ${REPORT_STATUSES.join("|")}.`, { code: "usage" });
          return EXIT.USAGE;
        }
        return await runReport({
          client,
          out,
          configDir: dir,
          agentId: agent.agentId,
          status,
          taskId: str(args.flags.task),
          note: str(args.flags.note),
        });
      }

      case "usage": {
        const client = makeClient();
        const agent = resolveAgent(args.flags, env, client, out);
        if (!agent.ok) return agent.code;
        return await runUsage({
          client,
          out,
          configDir: dir,
          agentId: agent.agentId,
          taskId: str(args.flags.task),
          usage: usageBody(args.flags),
        });
      }

      case "start":
      case "run": {
        const client = makeClient();
        const agent = resolveAgent(args.flags, env, client, out);
        if (!agent.ok) return agent.code;
        const project = resolveProject(args.flags, env, client, out);
        if (!project.ok) return project.code;
        const body = checkInBody(args.flags, project.projectId, out);
        if (!body) return EXIT.USAGE;
        return await runStart({
          client,
          out,
          configDir: dir,
          agentId: agent.agentId,
          body,
          command: args.rest,
          spawnImpl: overrides.spawnImpl,
        });
      }

      default:
        out.fail(`Unknown command: ${args.command}`, { code: "usage" });
        out.say(HELP);
        return EXIT.USAGE;
    }
  } catch (err) {
    if (err instanceof ApiError) {
      // `detail` (e.g. the subscription `status`) overrides the HTTP status in --json.
      out.fail(friendlyApiError(err, appBase), { code: err.code, status: err.status, ...err.detail });
      return exitCodeForApiError(err);
    }
    out.fail(`Error: ${errorMessage(err)}`, { code: "error" });
    return EXIT.ERROR;
  }
}
