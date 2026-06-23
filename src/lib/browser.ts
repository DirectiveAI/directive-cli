import { spawn } from "node:child_process";

/**
 * Best-effort "open this URL in the user's browser". Non-fatal if it fails — the
 * login flow always prints the URL so the user can open it manually.
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no browser available — caller already printed the URL */
    });
    child.unref();
  } catch {
    /* ignore — manual open */
  }
}
