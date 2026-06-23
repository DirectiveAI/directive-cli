import type { Output } from "../output.js";
import { errorMessage } from "../io.js";
import { EXIT } from "../exit.js";
import { openBrowser as defaultOpenBrowser } from "../lib/browser.js";
import { loginFlow } from "../lib/login.js";
import { deviceLoginFlow } from "../lib/device.js";
import { DirectiveClient } from "../lib/client.js";
import {
  clearActiveTask,
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type Credentials,
} from "../lib/config.js";
import type { TokenResponse } from "../lib/tokens.js";

export interface LoginCommandDeps {
  apiBase: string;
  appBase: string;
  out: Output;
  configDir: string;
  /** Use the headless device-authorization flow (RFC 8628) instead of loopback. */
  headless?: boolean;
  openBrowser?: (url: string) => void;
  fetchImpl?: typeof fetch;
  port?: number;
  /** Injectable timers for the device poll loop (tests). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * `directive login` — sign in and persist the tokens. Default is the browser PKCE
 * loopback flow; `--headless` uses the device-authorization flow (a code you
 * approve from any browser) for machines that can't open a browser or bind a
 * loopback port (CI, containers, SSH).
 */
export async function runLogin(d: LoginCommandDeps): Promise<number> {
  const fetchImpl = d.fetchImpl ?? globalThis.fetch;
  const openBrowser = d.openBrowser ?? defaultOpenBrowser;
  let tokens: TokenResponse;
  try {
    tokens = d.headless
      ? await deviceLoginFlow({ apiBase: d.apiBase, out: d.out, openBrowser, fetchImpl, sleep: d.sleep, now: d.now })
      : await loginFlow({ apiBase: d.apiBase, appBase: d.appBase, out: d.out, openBrowser, fetchImpl, port: d.port });
  } catch (err) {
    d.out.fail(`Login failed: ${errorMessage(err)}`, { code: "login_failed" });
    return EXIT.ERROR;
  }

  const creds: Credentials = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  };
  saveCredentials(creds, d.configDir);

  // Enrich with the account email (nice for `whoami` and the confirmation line).
  const client = new DirectiveClient({
    apiBase: d.apiBase,
    fetchImpl,
    load: () => loadCredentials(d.configDir),
    save: (c) => saveCredentials(c, d.configDir),
  });
  let email: string | undefined;
  try {
    const me = await client.me();
    email = me.user?.email ?? undefined;
    if (email) saveCredentials({ ...loadCredentials(d.configDir)!, email }, d.configDir);
    d.out.say(`Logged in as ${email ?? "your account"}.`);
  } catch {
    d.out.say("Logged in.");
  }
  d.out.result({ status: "logged_in", email: email ?? null });
  return EXIT.OK;
}

/** `directive logout` — forget the stored tokens and any active task. */
export function runLogout(d: { out: Output; configDir: string }): number {
  clearCredentials(d.configDir);
  clearActiveTask(d.configDir);
  d.out.say("Logged out.");
  d.out.result({ status: "logged_out" });
  return EXIT.OK;
}
