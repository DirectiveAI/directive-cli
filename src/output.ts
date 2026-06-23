import type { IO } from "./io.js";

/**
 * Command output that renders either human prose (default) or a single
 * machine-readable JSON object (`--json`). Commands describe *what* happened via
 * `say` (human line) and `result` (the structured payload); the mode decides how
 * it's rendered. The contract in `--json` mode: **exactly one JSON object on
 * stdout** — the result, or `{ "error": code, "message": … }` on failure — while
 * human/progress lines go to stderr and the exit code still signals success.
 */
export interface Output {
  readonly json: boolean;
  /** A human-readable line: stdout in human mode, stderr (progress) in `--json`. */
  say(human: string): void;
  /** The command's structured result — emitted as the JSON object only in `--json`. */
  result(data: Record<string, unknown>): void;
  /** An error: stderr in human mode; the `{ error, message }` JSON object in `--json`. */
  fail(human: string, data?: { code?: string; [k: string]: unknown }): void;
}

export function makeOutput(io: IO, json: boolean): Output {
  return {
    json,
    say(human) {
      if (json) io.err(human);
      else io.out(human);
    },
    result(data) {
      if (json) io.out(JSON.stringify(data));
    },
    fail(human, data = {}) {
      if (json) {
        const { code, ...rest } = data;
        io.out(JSON.stringify({ error: code ?? "error", message: human, ...rest }));
      } else {
        io.err(human);
      }
    },
  };
}
