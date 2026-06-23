import { spawn as defaultSpawn } from "node:child_process";
import type { Output } from "../output.js";
import { EXIT } from "../exit.js";
import type { CheckInBody, DirectiveClient } from "../lib/client.js";
import { clearActiveTask, saveActiveTask } from "../lib/config.js";

const DEFAULT_HEARTBEAT_MS = 60_000;

/** Minimal view of a spawned child so it can be faked in tests. */
export interface ChildLike {
  on(event: "exit", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}
export type SpawnLike = (cmd: string, args: string[]) => ChildLike;

export interface StartDeps {
  client: DirectiveClient;
  out: Output;
  configDir: string;
  agentId: string;
  body: CheckInBody;
  command: string[];
  heartbeatMs?: number;
  spawnImpl?: SpawnLike;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

/**
 * `directive start --title <t> -- <cmd...>` — the whole coordination loop around
 * a wrapped command: check in, heartbeat while it runs, then report completed (on
 * exit 0) or abandoned (non-zero). The heartbeat lives exactly as long as the
 * work, so a crash can't leave a claim looking alive.
 */
export async function runStart(d: StartDeps): Promise<number> {
  if (d.command.length === 0) {
    d.out.fail("Nothing to run. Usage: directive start --title <t> -- <command> [args…]", { code: "usage" });
    return EXIT.USAGE;
  }

  const res = await d.client.checkIn(d.agentId, d.body);
  if (res.status === "already_claimed") {
    d.out.say(`Already claimed by another agent: ${res.task.id} — skipping.`);
    d.out.result({ status: "already_claimed", task: res.task });
    return EXIT.ALREADY_CLAIMED;
  }
  const taskId = res.task.id;
  saveActiveTask({ task_id: taskId, claim_id: res.claim?.id, title: res.task.title }, d.configDir);
  d.out.say(`Claimed ${taskId} — ${res.task.title}. Running: ${d.command.join(" ")}`);

  const setIntervalFn = d.setIntervalFn ?? setInterval;
  const clearIntervalFn = d.clearIntervalFn ?? clearInterval;
  const spawnImpl: SpawnLike =
    d.spawnImpl ?? ((cmd, args) => defaultSpawn(cmd, args, { stdio: "inherit" }) as unknown as ChildLike);

  const beat = setIntervalFn(() => {
    void d.client.heartbeat(d.agentId, taskId).catch(() => {
      /* a missed beat isn't fatal; the next one (or expiry) handles it */
    });
  }, d.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawnImpl(d.command[0], d.command.slice(1));
    child.on("error", () => resolve(127)); // command not found / not executable
    child.on("exit", (code) => resolve(code ?? 0));
  });

  clearIntervalFn(beat);

  const status = exitCode === 0 ? "completed" : "abandoned";
  let reported = true;
  try {
    await d.client.report(d.agentId, taskId, status, `exit ${exitCode}`);
  } catch {
    reported = false;
    d.out.say("Warning: couldn't report the final status (the claim will expire on its own).");
  }
  clearActiveTask(d.configDir);
  d.out.say(`Reported ${status} (exit ${exitCode}).`);
  d.out.result({ status, task_id: taskId, exit_code: exitCode, reported });
  return exitCode;
}
