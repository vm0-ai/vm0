import { eq, and } from "drizzle-orm";
import { agentComposes } from "../db/schema/agent-compose";
import { zeroAgents } from "../db/schema/zero-agent";

interface AgentIdentity {
  displayName: string | null;
  description: string | null;
  sound: string | null;
}

const TONE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  professional:
    "Communicate in a clear, polished, and business-appropriate tone. Be thorough yet concise.",
  friendly:
    "Communicate in a warm, approachable, and conversational tone. Feel free to be casual while still being helpful.",
  direct:
    "Be brief and to the point. Skip pleasantries and filler — just deliver the information or action needed.",
  supportive:
    "Be encouraging and empathetic. Show that you're in the user's corner and proactively offer help.",
};

/**
 * Format agent identity metadata into a system prompt fragment.
 * Returns empty string if all fields are null/undefined.
 */
function formatAgentIdentityPrompt(identity: AgentIdentity): string {
  const parts: string[] = [];

  if (identity.displayName) {
    parts.push(`Your name is ${identity.displayName}.`);
  }

  if (identity.description) {
    parts.push(`Your role: ${identity.description}`);
  }

  if (identity.sound) {
    const instruction = TONE_INSTRUCTIONS[identity.sound];
    if (instruction) {
      parts.push(instruction);
    }
  }

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
