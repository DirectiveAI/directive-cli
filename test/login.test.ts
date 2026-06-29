import { describe, it, expect, vi } from "vitest";
import { get } from "node:http";
import { buildAuthorizeUrl, loginFlow, successPage, SKILL_INSTALL_COMMAND } from "../src/lib/login.js";
import { makeOutput } from "../src/output.js";

const silentOut = makeOutput({ out: () => {}, err: () => {} }, false);

/** Simulate the browser/page redirecting back to the CLI's loopback listener. */
function redirectingOpener(query: (state: string) => string) {
  return (authUrl: string) => {
    const u = new URL(authUrl);
    const redirect = u.searchParams.get("redirect_uri")!;
    const state = u.searchParams.get("state")!;
    get(`${redirect}?${query(state)}`, (res) => res.resume());
  };
}

describe("buildAuthorizeUrl", () => {
  it("targets /cli/authorize with the PKCE params", () => {
    const u = new URL(
      buildAuthorizeUrl("https://app.test", { codeChallenge: "CH", redirectUri: "http://127.0.0.1:5/cb", state: "S" }),
    );
    expect(u.origin + u.pathname).toBe("https://app.test/cli/authorize");
    expect(u.searchParams.get("code_challenge")).toBe("CH");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5/cb");
    expect(u.searchParams.get("state")).toBe("S");
  });
});

describe("successPage", () => {
  it("nudges the user to install the Directive skill with a copyable command", () => {
    const html = successPage("https://app.test/docs");
    // The headline confirms the sign-in and reassures the user they can leave.
    expect(html).toMatch(/Signed in/);
    expect(html).toMatch(/close this tab/i);
    // The nudge targets agent operators ("Using"), not just builders.
    expect(html).toMatch(/Using an AI agent\? Add the Directive skill:/);
    // The skill install command shows up verbatim, in a copyable element.
    expect(html).toContain(SKILL_INSTALL_COMMAND);
    expect(SKILL_INSTALL_COMMAND).toBe("npx skills add directiveai/agent-skills");
    expect(html).toMatch(/id="cmd"/);
    expect(html).toMatch(/id="copy"/);
    expect(html).toMatch(/navigator\.clipboard/);
    // "Learn more" points at the docs base it was handed (so it follows the env).
    expect(html).toContain('href="https://app.test/docs"');
  });

  it("defaults the docs link to the production app", () => {
    expect(successPage()).toContain('href="https://app.directive.ai/docs"');
  });
});

describe("loginFlow (loopback)", () => {
  it("serves the skill-install success page to the browser", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const body = await new Promise<string>((resolve) => {
      void loginFlow({
        apiBase: "https://api.test",
        appBase: "https://app.test",
        out: silentOut,
        openBrowser: (authUrl: string) => {
          const u = new URL(authUrl);
          const redirect = u.searchParams.get("redirect_uri")!;
          const state = u.searchParams.get("state")!;
          get(`${redirect}?code=THECODE&state=${state}`, (res) => {
            let html = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (html += c));
            res.on("end", () => resolve(html));
          });
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    });
    expect(body).toContain(SKILL_INSTALL_COMMAND);
    expect(body).toContain('href="https://app.test/docs"');
  });

  it("captures the code and exchanges it for tokens", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const tokens = await loginFlow({
      apiBase: "https://api.test",
      appBase: "https://app.test",
      out: silentOut,
      openBrowser: redirectingOpener((state) => `code=THECODE&state=${state}`),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(tokens.access_token).toBe("AT");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ grant_type: "authorization_code", code: "THECODE" });
    expect(typeof body.code_verifier).toBe("string");
  });

  it("rejects on a state mismatch (CSRF guard)", async () => {
    await expect(
      loginFlow({
        apiBase: "https://api.test",
        appBase: "https://app.test",
        out: silentOut,
        openBrowser: redirectingOpener(() => `code=X&state=WRONG`),
      }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it("rejects when the page returns an error", async () => {
    await expect(
      loginFlow({
        apiBase: "https://api.test",
        appBase: "https://app.test",
        out: silentOut,
        openBrowser: redirectingOpener(() => `error=access_denied`),
      }),
    ).rejects.toThrow(/access_denied/);
  });
});
