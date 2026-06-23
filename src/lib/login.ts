import { createServer, type Server } from "node:http";
import type { Output } from "../output.js";
import { generatePkce, randomToken } from "./pkce.js";
import { exchangeAuthCode, type TokenResponse } from "./tokens.js";

export interface LoginDeps {
  apiBase: string;
  appBase: string;
  out: Output;
  openBrowser: (url: string) => void;
  fetchImpl?: typeof fetch;
  /** Loopback port; 0 (default) picks a free one. */
  port?: number;
}

/** Build the browser authorize URL (`app.directive.ai/cli/authorize?...`). */
export function buildAuthorizeUrl(
  appBase: string,
  p: { codeChallenge: string; redirectUri: string; state: string },
): string {
  const u = new URL("/cli/authorize", appBase);
  u.searchParams.set("code_challenge", p.codeChallenge);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  return u.toString();
}

/** The command that installs the Directive agent skill (success page + tests share it). */
export const SKILL_INSTALL_COMMAND = "npx skills add directiveai/agent-skills";

const STYLES =
  ":root{color-scheme:light}*{box-sizing:border-box}" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  'background:#f1f5f9;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;padding:1.5rem}' +
  ".card{width:100%;max-width:30rem;background:#fff;border:1px solid #e2e8f0;border-radius:1rem;" +
  "box-shadow:0 10px 30px -12px rgba(15,23,42,.25);padding:2.5rem 2rem;text-align:center}" +
  ".badge{display:inline-flex;align-items:center;justify-content:center;width:3rem;height:3rem;" +
  "border-radius:.75rem;background:#f1f5f9;color:#0f172a;margin-bottom:1.25rem}.badge svg{width:1.5rem;height:1.5rem}" +
  "h1{margin:0;font-size:1.75rem;font-weight:700;letter-spacing:-.01em}" +
  ".muted{margin:.5rem 0 0;color:#64748b;font-size:1rem}" +
  ".divider{border:none;border-top:1px solid #e2e8f0;margin:1.75rem 0}" +
  ".prompt{display:flex;align-items:center;justify-content:center;gap:.4rem;color:#334155;font-size:.95rem;margin:0 0 .6rem}" +
  ".sparkle{color:#6366f1}" +
  ".cmd{display:flex;align-items:center;gap:.5rem;justify-content:space-between;background:#f8fafc;" +
  "border:1px solid #e2e8f0;border-radius:.6rem;padding:.6rem .9rem;text-align:left}" +
  ".cmd code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95rem;" +
  "color:#0f172a;white-space:nowrap;overflow:auto}" +
  ".copy{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:2rem;height:2rem;" +
  "border:none;background:transparent;border-radius:.4rem;color:#64748b;cursor:pointer}" +
  ".copy:hover{background:#e2e8f0;color:#0f172a}.copy svg{width:1.05rem;height:1.05rem}" +
  ".copy .i-check{display:none;color:#16a34a}.copy.copied .i-copy{display:none}.copy.copied .i-check{display:inline-flex}" +
  ".learn{display:inline-block;margin-top:1.25rem;color:#4f46e5;text-decoration:none;font-size:.95rem;font-weight:500}" +
  ".learn:hover{text-decoration:underline}";

const CHECK_BADGE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>';

/** Wrap a card body in the shared HTML shell. */
const shell = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Directive CLI</title>` +
  `<style>${STYLES}</style></head><body><main class="card">${body}</main></body></html>`;

/** A short status page for the cancelled / error cases. */
const statusPage = (heading: string) =>
  shell(`<h1>${heading}</h1><p class="muted">You can close this tab and return to your terminal.</p>`);

/**
 * The post-login success screen. Mirrors the Stripe CLI's "access granted" page:
 * confirms the sign-in, says it's safe to close the tab, and nudges agent builders
 * to install the Directive skill with a copy-to-clipboard command.
 */
export function successPage(docsUrl = "https://app.directive.ai/docs"): string {
  const copyIcon =
    '<svg class="i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
    '<svg class="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
  // No template literals / ${} in this script — it's embedded inside one.
  const script =
    "(function(){var b=document.getElementById('copy'),c=document.getElementById('cmd');" +
    "if(!b||!c||!navigator.clipboard)return;b.addEventListener('click',function(){" +
    "navigator.clipboard.writeText(c.textContent.trim()).then(function(){b.classList.add('copied');" +
    "b.title='Copied';setTimeout(function(){b.classList.remove('copied');b.title='Copy';},1500);});});})();";
  return shell(
    `<div class="badge">${CHECK_BADGE}</div>` +
      `<h1>Signed in</h1>` +
      `<p class="muted">You can close this tab and return to your terminal.</p>` +
      `<hr class="divider">` +
      `<p class="prompt"><span class="sparkle">✨</span> Using an AI agent? Add the Directive skill:</p>` +
      `<div class="cmd"><code id="cmd">${SKILL_INSTALL_COMMAND}</code>` +
      `<button id="copy" class="copy" type="button" title="Copy" aria-label="Copy command">${copyIcon}</button></div>` +
      `<a class="learn" href="${docsUrl}">Learn more about coordinating agents &rarr;</a>` +
      `<script>${script}</script>`,
  );
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}

/**
 * Run the OAuth authorization-code + PKCE loopback flow (RFC 8252). Starts a
 * localhost listener, opens the browser to the authorize page, waits for the
 * redirect back with `?code`, validates `state`, and exchanges the code for
 * tokens. Resolves with the token set (the caller persists it).
 */
export async function loginFlow(deps: LoginDeps): Promise<TokenResponse> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const { verifier, challenge } = generatePkce();
  const state = randomToken(16);

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");
    if (error) {
      res.writeHead(400, { "content-type": "text/html" }).end(statusPage("Authorization cancelled"));
      rejectCode(new Error(`authorization ${error}`));
      return;
    }
    if (!code || gotState !== state) {
      res.writeHead(400, { "content-type": "text/html" }).end(statusPage("Invalid authorization response"));
      rejectCode(new Error("state mismatch or missing code"));
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(successPage(new URL("/docs", deps.appBase).toString()));
    resolveCode(code);
  });

  const port = await listen(server, deps.port ?? 0);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authUrl = buildAuthorizeUrl(deps.appBase, { codeChallenge: challenge, redirectUri, state });

  deps.out.say(`Opening your browser to authorize the Directive CLI:\n  ${authUrl}\n`);
  deps.out.say("Waiting for you to approve in the browser…");
  deps.openBrowser(authUrl);

  try {
    const code = await codePromise;
    return await exchangeAuthCode(deps.apiBase, fetchImpl, { code, codeVerifier: verifier });
  } finally {
    server.close();
  }
}
