import type { Output } from "../output.js";
import { EXIT } from "../exit.js";
import type { DirectiveClient } from "../lib/client.js";

/** `directive org list` — the orgs you belong to, marking the current one. */
export async function runOrgList(d: { client: DirectiveClient; out: Output }): Promise<number> {
  const { orgs } = await d.client.listOrgs();
  const current = d.client.orgId();
  if (orgs.length === 0) {
    d.out.say("No orgs yet — create one at app.directive.ai.");
  } else {
    for (const o of orgs) d.out.say(`  ${o.id === current ? "*" : " "} ${o.id}  ${o.name ?? o.slug}  (${o.role})`);
  }
  d.out.result({ orgs, current_org: current ?? null });
  return EXIT.OK;
}

/** `directive org use <id>` — set the current org for org-scoped commands. */
export function runOrgUse(d: { client: DirectiveClient; out: Output; orgId?: string }): number {
  if (!d.orgId) {
    d.out.fail("Missing org id. Usage: `directive org use <id>`.", { code: "usage" });
    return EXIT.USAGE;
  }
  d.client.setOrgId(d.orgId);
  d.out.say(`Current org set to ${d.orgId}.`);
  d.out.result({ current_org: d.orgId });
  return EXIT.OK;
}
