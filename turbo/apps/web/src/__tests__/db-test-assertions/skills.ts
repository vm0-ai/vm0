import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { skills } from "@vm0/db/schema/skill";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

// ---------------------------------------------------------------------------
// Read-only assertion helpers for skill test verification.
// ---------------------------------------------------------------------------

/**
 * Find a skill by its canonical URL.
 */
export async function findTestSkillByUrl(url: string) {
  initServices();
  const [skill] = await globalThis.services.db
    .select()
    .from(skills)
    .where(eq(skills.url, url))
    .limit(1);
  return skill ?? null;
}

/**
 * Get the customSkills array for a given agent.
 */
export async function getAgentCustomSkills(agentId: string): Promise<string[]> {
  initServices();
  const [agent] = await globalThis.services.db
    .select({ customSkills: zeroAgents.customSkills })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  return agent.customSkills;
}
