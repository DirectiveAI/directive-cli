import type { Output } from "../output.js";
import { EXIT } from "../exit.js";
import type { CheckInBody, DirectiveClient, ReportStatus, UsageBody } from "../lib/client.js";
import { clearActiveTask, loadActiveTask, saveActiveTask } from "../lib/config.js";

/** Exit code when a task is already held by another agent (so scripts can branch). */
export const ALREADY_CLAIMED = EXIT.ALREADY_CLAIMED;

/** Resolve the task to act on: an explicit id, else the CLI's active task. */
function resolveTaskId(explicit: string | undefined, configDir: string, out: Output): string | null {
  if (explicit) return explicit;
  const active = loadActiveTask(configDir);
  if (active) return active.task_id;
  out.fail("No task specified and no active task. Pass --task <id> or run `directive check-in` first.", {
    code: "no_active_task",
  });
  return null;
}

/** `directive check-in --title <t> [...]` — the dedup/claim step. */
export async function runCheckIn(d: {
  client: DirectiveClient;
  out: Output;
  configDir: string;
  agentId: string;
  body: CheckInBody;
}): Promise<number> {
  const res = await d.client.checkIn(d.agentId, d.body);
  if (res.status === "claimed") {
    saveActiveTask({ task_id: res.task.id, claim_id: res.claim?.id, title: res.task.title }, d.configDir);
    d.out.say(`Claimed ${res.task.id} — ${res.task.title}`);
    d.out.result({ status: "claimed", task: res.task, claim: res.claim, created: res.created });
    return EXIT.OK;
  }
  d.out.say(`Already claimed by another agent: ${res.task.id} — ${res.task.title}`);
  d.out.result({ status: "already_claimed", task: res.task, claim: res.claim, created: res.created });
  return EXIT.ALREADY_CLAIMED;
}

/** `directive heartbeat [--task <id>]` — keep the claim alive. */
export async function runHeartbeat(d: {
  client: DirectiveClient;
  out: Output;
  configDir: string;
  agentId: string;
  taskId?: string;
}): Promise<number> {
  const taskId = resolveTaskId(d.taskId, d.configDir, d.out);
  if (!taskId) return EXIT.USAGE;
  await d.client.heartbeat(d.agentId, taskId);
  d.out.say(`Heartbeat sent for ${taskId}.`);
  d.out.result({ status: "ok", task_id: taskId });
  return EXIT.OK;
}

/** `directive report --status <s> [--task <id>] [--note <n>]` — progress / release. */
export async function runReport(d: {
  client: DirectiveClient;
  out: Output;
  configDir: string;
  agentId: string;
  status: ReportStatus;
  taskId?: string;
  note?: string;
}): Promise<number> {
  const taskId = resolveTaskId(d.taskId, d.configDir, d.out);
  if (!taskId) return EXIT.USAGE;
  const { task } = await d.client.report(d.agentId, taskId, d.status, d.note);
  d.out.say(`Reported ${d.status} for ${taskId} (now ${task.status}).`);
  d.out.result({ status: "reported", reported: d.status, task });
  // A terminal outcome frees the active-task slot ("blocked" keeps the claim).
  if (d.status !== "blocked") {
    const active = loadActiveTask(d.configDir);
    if (active?.task_id === taskId) clearActiveTask(d.configDir);
  }
  return EXIT.OK;
}

/** `directive usage --input <n> --output <n> [--model <m>] [--cost <micro_usd>]`. */
export async function runUsage(d: {
  client: DirectiveClient;
  out: Output;
  configDir: string;
  agentId: string;
  usage: UsageBody;
  taskId?: string;
}): Promise<number> {
  const taskId = resolveTaskId(d.taskId, d.configDir, d.out);
  if (!taskId) return EXIT.USAGE;
  if ((d.usage.input_tokens ?? 0) + (d.usage.output_tokens ?? 0) <= 0) {
    d.out.fail("Nothing to record: pass --input and/or --output token counts (> 0).", { code: "usage" });
    return EXIT.USAGE;
  }
  await d.client.reportUsage(d.agentId, taskId, d.usage);
  d.out.say(`Recorded usage for ${taskId}.`);
  d.out.result({ status: "recorded", task_id: taskId, usage: d.usage });
  return EXIT.OK;
}
