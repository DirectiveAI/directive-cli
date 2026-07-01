import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Stored login credentials (the refresh token is long-lived; access token short). */
export interface Credentials {
  access_token: string;
  refresh_token: string;
  /** Unix epoch **milliseconds** when the access token expires. */
  expires_at: number;
  email?: string;
  /** The agent this CLI acts as by default (X-Directive-Agent-Id). */
  agent_id?: string;
  /** The org this CLI targets by default (org-scoped commands like agent/project). */
  org_id?: string;
  /** The project this CLI checks in to by default (every task needs a project). */
  project_id?: string;
}

/** The "current" task, so heartbeat/report/usage can default to it. */
export interface ActiveTask {
  task_id: string;
  claim_id?: string;
  title?: string;
}

/**
 * The Directive config directory: `$DIRECTIVE_CONFIG_DIR` (explicit override, used
 * by tests), else `$XDG_CONFIG_HOME/directive`, else `~/.config/directive`.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DIRECTIVE_CONFIG_DIR) return env.DIRECTIVE_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "directive");
}

const credPath = (dir: string) => join(dir, "credentials.json");
const statePath = (dir: string) => join(dir, "state.json");

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write JSON with owner-only (0600) permissions — these files hold tokens. */
function writeSecret(path: string, value: unknown, dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // ensure perms even if the file already existed
  } catch {
    /* non-POSIX filesystem — best effort */
  }
}

/**
 * Credentials supplied via the environment, for headless / CI use (no browser
 * login, no on-disk token file). `DIRECTIVE_REFRESH_TOKEN` is the recommended
 * shape — store it as a CI secret and the CLI mints a fresh access token per run
 * (we mark it already-expired so the client refreshes on first use).
 * `DIRECTIVE_TOKEN` alone supplies a short-lived access token with no refresh.
 * Returns `null` when neither is set (the caller falls back to the on-disk store).
 */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  const access = env.DIRECTIVE_TOKEN?.trim();
  const refresh = env.DIRECTIVE_REFRESH_TOKEN?.trim();
  if (!access && !refresh) return null;
  return {
    access_token: access ?? "",
    refresh_token: refresh ?? "",
    // With a refresh token, force an immediate refresh (we don't know the access
    // token's age); with only an access token, assume it's fresh (no refresh path).
    expires_at: refresh ? 0 : Date.now() + 3_600_000,
    agent_id: env.DIRECTIVE_AGENT_ID?.trim() || undefined,
    org_id: env.DIRECTIVE_ORG_ID?.trim() || undefined,
    project_id: env.DIRECTIVE_PROJECT_ID?.trim() || undefined,
  };
}

export function loadCredentials(dir = configDir()): Credentials | null {
  return readJson<Credentials>(credPath(dir));
}

export function saveCredentials(creds: Credentials, dir = configDir()): void {
  writeSecret(credPath(dir), creds, dir);
}

export function clearCredentials(dir = configDir()): void {
  try {
    rmSync(credPath(dir));
  } catch {
    /* already gone */
  }
}

export function loadActiveTask(dir = configDir()): ActiveTask | null {
  return readJson<ActiveTask>(statePath(dir));
}

export function saveActiveTask(task: ActiveTask, dir = configDir()): void {
  writeSecret(statePath(dir), task, dir);
}

export function clearActiveTask(dir = configDir()): void {
  try {
    rmSync(statePath(dir));
  } catch {
    /* already gone */
  }
}
