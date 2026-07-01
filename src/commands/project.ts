import type { Output } from "../output.js";
import { EXIT } from "../exit.js";
import type { DirectiveClient } from "../lib/client.js";

/** `directive project list` — the projects you belong to in the current org. */
export async function runProjectList(d: { client: DirectiveClient; out: Output; orgId: string }): Promise<number> {
  const { projects } = await d.client.listProjects(d.orgId);
  const current = d.client.projectId();
  if (projects.length === 0) {
    d.out.say("No projects yet. Create one with `directive project create --org <id> --name <name>`.");
  } else {
    for (const p of projects) d.out.say(`  ${p.id === current ? "*" : " "} ${p.id}  ${p.name}  (${p.slug})`);
  }
  d.out.result({ projects, current_project: current ?? null });
  return EXIT.OK;
}

/**
 * `directive project create [--org <id>] --name <name> [--slug <s>] [--description <d>]`
 * — create a project in the current org and set it as this CLI's current project.
 */
export async function runProjectCreate(d: {
  client: DirectiveClient;
  out: Output;
  orgId: string;
  name?: string;
  slug?: string;
  description?: string;
}): Promise<number> {
  if (!d.name) {
    d.out.fail("Missing --name <name>.", { code: "usage" });
    return EXIT.USAGE;
  }
  const { project } = await d.client.createProject(d.orgId, { name: d.name, slug: d.slug, description: d.description });
  d.client.setProjectId(project.id);
  d.out.say(`Created project ${project.id} ("${project.name}") and set it as the current project.`);
  d.out.result({ project, current: true });
  return EXIT.OK;
}

/** `directive project use <id>` — set the current project for future check-ins. */
export async function runProjectUse(d: { client: DirectiveClient; out: Output; projectId?: string }): Promise<number> {
  if (!d.projectId) {
    d.out.fail("Missing project id. Usage: `directive project use <id>`.", { code: "usage" });
    return EXIT.USAGE;
  }
  d.client.setProjectId(d.projectId);
  d.out.say(`Current project set to ${d.projectId}.`);
  d.out.result({ current_project: d.projectId });
  return EXIT.OK;
}
