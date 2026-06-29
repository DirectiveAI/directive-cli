import { ApiError } from "./errors.js";

/** The token endpoint's response (`POST /v1/cli/auth/token`). */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

async function postToken(
  apiBase: string,
  fetchImpl: typeof fetch,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetchImpl(`${apiBase}/v1/cli/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !json.access_token || !json.refresh_token) {
    throw new ApiError(res.status, json.error ?? `token_request_failed_${res.status}`);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in ?? 3600,
    token_type: json.token_type ?? "Bearer",
  };
}

/** Exchange a PKCE authorization code for tokens. */
export function exchangeAuthCode(
  apiBase: string,
  fetchImpl: typeof fetch,
  input: { code: string; codeVerifier: string },
): Promise<TokenResponse> {
  return postToken(apiBase, fetchImpl, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
  });
}

/** Exchange a refresh token for a fresh access (and refresh) token. */
export function exchangeRefresh(
  apiBase: string,
  fetchImpl: typeof fetch,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(apiBase, fetchImpl, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** The RFC 8628 device-authorization grant type (poll value at the token endpoint). */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** The device-authorization response (`POST /v1/cli/auth/device`). */
export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Start the device-authorization flow (RFC 8628) — the headless login fallback. */
export async function requestDeviceAuthorization(
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<DeviceAuthorization> {
  const res = await fetchImpl(`${apiBase}/v1/cli/auth/device`, { method: "POST" });
  const json = (await res.json().catch(() => ({}))) as Partial<DeviceAuthorization> & { error?: string };
  if (!res.ok || !json.device_code || !json.user_code) {
    throw new ApiError(res.status, json.error ?? `device_request_failed_${res.status}`);
  }
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri ?? "",
    verification_uri_complete: json.verification_uri_complete ?? json.verification_uri ?? "",
    expires_in: json.expires_in ?? 900,
    interval: json.interval ?? 5,
  };
}

/** The outcome of one device-token poll (RFC 8628 poll semantics). */
export type DevicePoll =
  | { status: "ok"; tokens: TokenResponse }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; code: string };

/**
 * Poll the token endpoint once with a `device_code`. Unlike the other grants this
 * never throws on the expected "keep waiting" responses (`authorization_pending` /
 * `slow_down`) — it returns them so the caller can implement the poll loop.
 */
export async function pollDeviceToken(
  apiBase: string,
  fetchImpl: typeof fetch,
  deviceCode: string,
): Promise<DevicePoll> {
  const res = await fetchImpl(`${apiBase}/v1/cli/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (res.ok && json.access_token && json.refresh_token) {
    return {
      status: "ok",
      tokens: {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_in: json.expires_in ?? 3600,
        token_type: json.token_type ?? "Bearer",
      },
    };
  }
  switch (json.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "error", code: json.error ?? `http_${res.status}` };
  }
}
