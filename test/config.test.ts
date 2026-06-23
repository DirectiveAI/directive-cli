import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearActiveTask,
  clearCredentials,
  configDir,
  credentialsFromEnv,
  loadActiveTask,
  loadCredentials,
  saveActiveTask,
  saveCredentials,
} from "../src/lib/config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "directive-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("credential store", () => {
  it("round-trips credentials and writes them 0600", () => {
    expect(loadCredentials(dir)).toBeNull();
    saveCredentials({ access_token: "a", refresh_token: "r", expires_at: 123, email: "x@y.co" }, dir);
    expect(loadCredentials(dir)).toMatchObject({ access_token: "a", refresh_token: "r", expires_at: 123 });
    expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
    clearCredentials(dir);
    expect(loadCredentials(dir)).toBeNull();
  });

  it("round-trips the active task", () => {
    expect(loadActiveTask(dir)).toBeNull();
    saveActiveTask({ task_id: "t1", claim_id: "c1", title: "T" }, dir);
    expect(loadActiveTask(dir)).toMatchObject({ task_id: "t1", claim_id: "c1" });
    clearActiveTask(dir);
    expect(loadActiveTask(dir)).toBeNull();
  });
});

describe("credentialsFromEnv", () => {
  it("returns null when no env credentials are set", () => {
    expect(credentialsFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("treats a bare DIRECTIVE_TOKEN as a fresh, non-refreshable access token", () => {
    const c = credentialsFromEnv({ DIRECTIVE_TOKEN: "  at  " } as NodeJS.ProcessEnv)!;
    expect(c.access_token).toBe("at");
    expect(c.refresh_token).toBe("");
    expect(c.expires_at).toBeGreaterThan(Date.now()); // assumed valid, no refresh path
  });

  it("forces an immediate refresh when a refresh token is supplied", () => {
    const c = credentialsFromEnv({ DIRECTIVE_REFRESH_TOKEN: "rt", DIRECTIVE_AGENT_ID: "A9" } as NodeJS.ProcessEnv)!;
    expect(c.refresh_token).toBe("rt");
    expect(c.expires_at).toBe(0); // already-expired → client refreshes on first use
    expect(c.agent_id).toBe("A9");
  });
});

describe("configDir", () => {
  it("prefers DIRECTIVE_CONFIG_DIR, then XDG, then HOME/.config", () => {
    expect(configDir({ DIRECTIVE_CONFIG_DIR: "/x/y" } as NodeJS.ProcessEnv)).toBe("/x/y");
    expect(configDir({ XDG_CONFIG_HOME: "/cfg" } as NodeJS.ProcessEnv)).toBe(join("/cfg", "directive"));
    expect(configDir({ HOME: "/home/u" } as NodeJS.ProcessEnv)).toBe(join("/home/u", ".config", "directive"));
  });
});
