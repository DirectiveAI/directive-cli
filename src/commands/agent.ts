import type { Output } from "../output.js";
import { EXIT } from "../exit.js";
import type { DirectiveClient } from "../lib/client.js";

/**
 * `directive agent create [--org <id>] --name <name>` — register an agent in the
 * current org and remember it as this CLI's default (so task commands don't need
 * --agent). The org defaults to the current one (`directive org use`).
 */
export async function runAgentCreate(d: {
  client: DirectiveClient;
  out: Output;
  orgId: string;
  name?: string;
}): Promise<number> {
  const name = d.name ?? "directive-cli";
  const { agent } = await d.client.createAgent(d.orgId, name);
  d.client.setAgentId(agent.id);
  d.out.say(`Registered agent ${agent.id} ("${agent.name}") and set it as the default.`);
  d.out.result({ agent, default: true });
  return EXIT.OK;
}

/** `directive agent list` — agents registered in the current org. */
export async function runAgentList(d: { client: DirectiveClient; out: Output; orgId: string }): Promise<number> {
  const { agents } = await d.client.listAgents(d.orgId);
  const current = d.client.agentId();
  if (agents.length === 0) {
    d.out.say("No agents yet. Create one with `directive agent create --org <id> --name <name>`.");
  } else {
    for (const a of agents) d.out.say(`  ${a.id === current ? "*" : " "} ${a.id}  ${a.name}`);
  }
  d.out.result({ agents, default_agent: current ?? null });
  return EXIT.OK;
}
