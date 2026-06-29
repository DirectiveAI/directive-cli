import type { Output } from "../output.js";
import { EXIT } from "../exit.js";
import { loadActiveTask } from "../lib/config.js";
import type { DirectiveClient } from "../lib/client.js";

/** `directive whoami` — the signed-in account, its orgs, and the active task. */
export async function runWhoami(d: { client: DirectiveClient; out: Output; configDir: string }): Promise<number> {
  if (!d.client.isAuthenticated()) {
    d.out.fail("Not logged in. Run `directive login`.", { code: "not_authenticated" });
    return EXIT.AUTH;
  }
  const me = await d.client.me();
  const orgs = me.orgs ?? [];
  const agent = d.client.agentId();
  const project = d.client.projectId();
  const active = loadActiveTask(d.configDir);

  d.out.say(me.user?.email ?? "(unknown account)");
  if (orgs.length === 0) {
    d.out.say("  (no orgs yet — create one at app.directive.ai)");
  } else {
    d.out.say("Orgs:");
    for (const o of orgs) d.out.say(`  ${o.id}  ${o.name ?? o.slug}  (${o.role})`);
  }
  if (agent) d.out.say(`Default agent: ${agent}`);
  if (project) d.out.say(`Current project: ${project}`);
  if (active) d.out.say(`Active task: ${active.task_id}${active.title ? ` — ${active.title}` : ""}`);

  d.out.result({
    user: me.user ?? null,
    orgs,
    default_agent: agent ?? null,
    current_project: project ?? null,
    active_task: active ?? null,
  });
  return EXIT.OK;
}
