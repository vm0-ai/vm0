import { eq } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";

export async function resolveAgentSystemPrompt(
  agentId: string | null,
): Promise<string> {
  if (!agentId) return "";
  const db = globalThis.services.db;
  const [row] = await db
    .select({ content: agentComposeVersions.content })
    .from(agentComposes)
    .leftJoin(
      agentComposeVersions,
      eq(agentComposeVersions.id, agentComposes.headVersionId),
    )
    .where(eq(agentComposes.id, agentId))
    .limit(1);
  if (!row?.content || typeof row.content !== "object") return "";
  const content = row.content as {
    agents?: Record<string, { description?: string }>;
  };
  const firstAgent = content.agents
    ? Object.values(content.agents)[0]
    : undefined;
  return firstAgent?.description ?? "";
}
