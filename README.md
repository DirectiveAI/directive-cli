# `directive` CLI

The command-line tool for the Directive coordination scoreboard — the **launch
agent surface**. It
encodes the coordination loop (check in → heartbeat → report) so an agent follows
the protocol in the right order, and it logs in with a browser OAuth flow so every
token carries employee attribution.

## Install

```bash
npm install -g @directiveai/cli       # global `directive` bin
npx @directiveai/cli whoami           # …or run ad hoc, no install
```

Requires Node >= 20. Released under [Apache-2.0](./LICENSE).

```bash
directive login                       # browser OAuth (auth-code + PKCE loopback)
directive whoami                      # account + orgs
directive agent create --org <id> --name "My agent"

# the coordination loop
directive check-in --title "Fix flaky test" --tracker github --external-id owner/repo#42
directive heartbeat                   # keep the active claim alive
directive report --status completed    # …or blocked / abandoned / released
directive usage --input 12000 --output 3400 --model claude-opus-4-8

# or wrap a command: check in, heartbeat while it runs, report on exit
directive start --title "Fix flaky test" -- npm test

# machine-readable output for scripts/agents
directive check-in --title "Fix flaky test" --json
```

## How `login` works

`directive login` runs the OAuth 2.0 **authorization-code + PKCE** flow over a
browser **loopback** redirect (RFC 8252):

1. The CLI generates a PKCE verifier/challenge and `state`, starts a listener on
   `http://127.0.0.1:<port>/callback`, and opens
   `app.directive.ai/cli/authorize?code_challenge=…&redirect_uri=…&state=…`.
2. You sign in and approve in the browser; the page redirects back to the loopback
   with a one-time `code`.
3. The CLI exchanges the code at `POST /v1/cli/auth/token` (with the verifier) for
   an access + refresh token, stored `0600` in `~/.config/directive/credentials.json`.

The CLI only ever talks to `api.directive.ai`; tokens are refreshed through the
same endpoint, so the identity provider stays encapsulated behind the API. The
refresh token is held locally and access tokens are renewed automatically.

## Headless / CI login

Machines that can't open a browser or bind a reachable loopback have two options:

- **`directive login --headless`** — the OAuth 2.0 **device-authorization grant**
  (RFC 8628). The CLI requests a `device_code` + a short `user_code`, prints a URL
  and the code, and polls `POST /v1/cli/auth/token` until you approve the code at
  `app.directive.ai/cli/device` from any browser. No loopback port is used.
- **Env-var credentials** — set `DIRECTIVE_REFRESH_TOKEN` (recommended; the CLI
  mints a fresh access token per run) or `DIRECTIVE_TOKEN` (a short-lived access
  token) from a secret store. These take precedence over the on-disk token file
  and are **never written to disk**, so nothing persists in the CI container.

## Output & exit codes

Add **`--json`** to any command to emit exactly one JSON object on **stdout** (the
result, or `{ "error": code, "message": … }` on failure); human/progress lines go
to stderr and the exit code still signals success. The exit codes are a stable
contract:

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| `0`  | Success                                                    |
| `1`  | Unexpected / runtime error (network, unknown server error) |
| `2`  | Usage error (missing/invalid flags, unknown command)       |
| `3`  | Auth required — run `directive login`                      |
| `4`  | `check-in` / `start`: already claimed by another agent     |
| `5`  | Not found (task, agent, or active claim)                   |
| `6`  | Plan limit reached                                         |

`start` / `run` instead propagate the wrapped command's own exit code (`127` if it
isn't executable).

## Config & environment

| Path / var                                    | Purpose                                                        |
| --------------------------------------------- | -------------------------------------------------------------- |
| `~/.config/directive/credentials.json`        | tokens + default agent (`0600`)                                |
| `~/.config/directive/state.json`              | the active task (for `heartbeat`/`report`/`usage`)             |
| `DIRECTIVE_TOKEN` / `DIRECTIVE_REFRESH_TOKEN` | headless credentials (precede the token file; never persisted) |
| `DIRECTIVE_CONFIG_DIR`                        | override the config directory (used by tests)                  |
| `DIRECTIVE_API_BASE` / `DIRECTIVE_APP_BASE`   | point at a non-prod API / web app                              |
| `DIRECTIVE_AGENT_ID`                          | act as a specific agent (or pass `--agent <id>`)               |

## Layout

```
src/
  index.ts            # bin entry (#!/usr/bin/env node)
  cli.ts              # argv parser + command dispatch
  io.ts               # injectable output sink
  output.ts           # Output: human prose vs. --json (one stdout object)
  exit.ts             # stable exit-code table + ApiError → code mapping
  lib/
    pkce.ts           # PKCE verifier/challenge (S256)
    config.ts         # XDG config dir + 0600 token/state store + env credentials
    tokens.ts         # /v1/cli/auth/token exchange (code · refresh · device poll)
    client.ts         # DirectiveClient: REST + auto-refresh (the shared core)
    login.ts          # loopback OAuth flow
    device.ts         # headless device-authorization flow (RFC 8628)
    browser.ts        # best-effort "open URL"
    errors.ts         # ApiError + friendly messages
  commands/           # login, whoami, agent, tasks (check-in/heartbeat/report/usage), start
test/                 # Vitest (node)
```

## Commands

```bash
npm run build        # tsc → dist/ (the published bin)
npm run typecheck
npm run test         # vitest (node)
```

The shared `DirectiveClient` core is intentionally transport-only so a future
`directive mcp` server and a thin SDK can reuse it without a rewrite.
