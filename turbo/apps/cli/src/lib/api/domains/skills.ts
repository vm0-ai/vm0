import { initClient } from "@ts-rest/core";
import { skillsResolveContract } from "@vm0/core";
import { getClientConfig } from "../core/client-factory";
import chalk from "chalk";

/**
 * Batch-resolve skill URLs against the server's skill cache.
 * Returns resolved skills (cached) and unresolved skills (need download).
 * Gracefully degrades: any error returns all skills as unresolved.
 */
export async function resolveSkills(skillUrls: string[]) {
  try {
    const config = await getClientConfig();
    const client = initClient(skillsResolveContract, config);
    const result = await client.resolve({ body: { skills: skillUrls } });
    if (result.status === 200) return result.body;
    console.error(
      chalk.dim("  Skill resolve unavailable, downloading all skills"),
    );
    return { resolved: {}, unresolved: skillUrls };
  } catch {
    console.error(
      chalk.dim("  Skill resolve unavailable, downloading all skills"),
    );
    return { resolved: {}, unresolved: skillUrls };
  }
}
