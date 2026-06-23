import { describe, it, expect, vi } from "vitest";
import { deviceLoginFlow } from "../src/lib/device.js";
import { makeOutput } from "../src/output.js";

const out = makeOutput({ out: () => {}, err: () => {} }, false);
const noSleep = () => Promise.resolve();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const deviceAuth = {
  device_code: "DEV",
  user_code: "BCDF-GHJK",
  verification_uri: "https://app.test/cli/device",
  verification_uri_complete: "https://app.test/cli/device?user_code=BCDF-GHJK",
  expires_in: 900,
  interval: 1,
};

/** A fetch stub that returns the device authorization, then a scripted poll sequence. */
function deviceFetch(pollResponses: Array<{ body: unknown; status?: number }>) {
  let poll = 0;
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/v1/cli/auth/device")) return json(deviceAuth);
    if (u.endsWith("/v1/cli/auth/token")) {
      const r = pollResponses[Math.min(poll, pollResponses.length - 1)];
      poll++;
      return json(r.body, r.status ?? (r.body && (r.body as { error?: string }).error ? 400 : 200));
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

describe("deviceLoginFlow", () => {
  it("requests a device code, prints the user_code, and opens the verification URL", async () => {
    const opened: string[] = [];
    const lines: string[] = [];
    const fetchImpl = deviceFetch([
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" } },
    ]);
    const tokens = await deviceLoginFlow({
      apiBase: "https://api.test",
      out: makeOutput({ out: (m) => lines.push(m), err: (m) => lines.push(m) }, false),
      openBrowser: (u) => opened.push(u),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(tokens.access_token).toBe("AT");
    expect(opened).toContain(deviceAuth.verification_uri_complete);
    expect(lines.join("\n")).toContain("BCDF-GHJK");
  });

  it("polls through authorization_pending and slow_down until approved", async () => {
    const fetchImpl = deviceFetch([
      { body: { error: "authorization_pending" } },
      { body: { error: "slow_down" } },
      { body: { access_token: "AT", refresh_token: "RT", expires_in: 3600, token_type: "Bearer" } },
    ]);
    const tokens = await deviceLoginFlow({
      apiBase: "https://api.test",
      out,
      openBrowser: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(tokens.refresh_token).toBe("RT");
    // device start + 3 polls
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("throws when the request is denied", async () => {
    const fetchImpl = deviceFetch([{ body: { error: "access_denied" } }]);
    await expect(
      deviceLoginFlow({
        apiBase: "https://api.test",
        out,
        openBrowser: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/denied/i);
  });

  it("throws when the device code expires before approval", async () => {
    const fetchImpl = deviceFetch([{ body: { error: "expired_token" } }]);
    await expect(
      deviceLoginFlow({
        apiBase: "https://api.test",
        out,
        openBrowser: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/expired/i);
  });

  it("times out once the expiry deadline passes", async () => {
    // Always pending; advance the injected clock past expires_in on the second look.
    const fetchImpl = deviceFetch([{ body: { error: "authorization_pending" } }]);
    let t = 1000;
    const now = () => {
      t += 1_000_000; // jump well past the 900s window
      return t;
    };
    await expect(
      deviceLoginFlow({
        apiBase: "https://api.test",
        out,
        openBrowser: () => {},
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
        now,
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
