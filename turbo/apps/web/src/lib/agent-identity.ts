import { eq, and } from "drizzle-orm";
import { agentComposes } from "../db/schema/agent-compose";
import { zeroAgents } from "../db/schema/zero-agent";

interface AgentIdentity {
  displayName: string | null;
  description: string | null;
  sound: string | null;
}

/**
 * Format agent identity metadata into a system prompt fragment.
 * Returns empty string if all fields are null/undefined.
 */
export function formatAgentIdentityPrompt(identity: AgentIdentity): string {
  const parts: string[] = [];

  if (identity.displayName) {
    parts.push(`You are ${identity.displayName}.`);
  }

  if (identity.description) {
    parts.push(identity.description);
  }

  if (identity.sound) {
    parts.push(`Communication style: ${identity.sound}`);
  }

  if (parts.length === 0) return "";

  return `# Agent Identity\n${parts.join("\n")}`;
}

/**
 * Build a system prompt fragment with the agent's identity metadata.
 *
 * Queries zeroAgents by joining through agentComposes to resolve the
 * (orgId, name) key from a composeId. Returns empty string if the
 * compose or metadata is not found.
 */
export async function buildAgentIdentityPrompt(
  composeId: string,
): Promise<string> {
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(agentComposes)
    .innerJoin(
      zeroAgents,
      and(
        eq(zeroAgents.orgId, agentComposes.orgId),
        eq(zeroAgents.name, agentComposes.name),
      ),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!row) return "";

  return formatAgentIdentityPrompt(row);
}
