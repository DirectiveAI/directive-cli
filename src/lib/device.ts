import type { Output } from "../output.js";
import { pollDeviceToken, requestDeviceAuthorization, type TokenResponse } from "./tokens.js";

export interface DeviceLoginDeps {
  apiBase: string;
  out: Output;
  openBrowser: (url: string) => void;
  fetchImpl?: typeof fetch;
  /** Injectable for tests (default: real timers / clock). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the OAuth 2.0 device-authorization flow (RFC 8628) — the headless
 * `directive login --headless`. Asks the API for a `device_code` + a short
 * `user_code`, shows the user where to approve it, then polls the token endpoint
 * (honouring the server's `interval` and `slow_down`) until it's approved, denied,
 * or expires. Resolves with the token set (the caller persists it). No browser or
 * loopback port is required — only outbound HTTPS to the API.
 */
export async function deviceLoginFlow(deps: DeviceLoginDeps): Promise<TokenResponse> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  const auth = await requestDeviceAuthorization(deps.apiBase, fetchImpl);

  deps.out.say(
    `To sign in, open this URL in any browser:\n  ${auth.verification_uri}\n` +
      `and enter the code:\n\n  ${auth.user_code}\n`,
  );
  deps.out.say("Waiting for you to approve in the browser…");
  if (auth.verification_uri_complete) deps.openBrowser(auth.verification_uri_complete);

  let interval = Math.max(1, auth.interval) * 1000;
  const deadline = now() + auth.expires_in * 1000;

  while (now() < deadline) {
    await sleep(interval);
    const poll = await pollDeviceToken(deps.apiBase, fetchImpl, auth.device_code);
    switch (poll.status) {
      case "ok":
        return poll.tokens;
      case "pending":
        continue;
      case "slow_down":
        interval += 5000; // RFC 8628: back off by 5s and keep polling
        continue;
      case "denied":
        throw new Error("authorization was denied in the browser");
      case "expired":
        throw new Error("the device code expired before it was approved");
      default:
        throw new Error(`device authorization failed (${poll.code})`);
    }
  }
  throw new Error("timed out waiting for approval");
}
