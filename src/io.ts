/** Output sink — injectable so commands are testable without touching stdio. */
export interface IO {
  out: (msg: string) => void;
  err: (msg: string) => void;
}

export const consoleIO: IO = {
  out: (m) => process.stdout.write(m + "\n"),
  err: (m) => process.stderr.write(m + "\n"),
};

/** Best-effort message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
