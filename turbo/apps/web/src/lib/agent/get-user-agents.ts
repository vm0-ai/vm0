import { eq, inArray } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import type { AgentComposeYaml } from "../../types/agent-compose";

interface UserAgent {
  composeId: string;
  agentName: string;
  headVersionId: string | null;
}

/**
 * Fetch all agents owned by a user.
 */
export async function getUserAgents(userId: string): Promise<UserAgent[]> {
  const db = globalThis.services.db;

  return db
    .select({
      composeId: agentComposes.id,
      agentName: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.userId, userId));
}

/**
 * Batch-fetch compose version contents by their IDs.
 * Returns a Map from versionId to parsed compose YAML.
 */
export async function batchFetchVersionContents(
  versionIds: string[],
): Promise<Map<string, AgentComposeYaml>> {
  const contents = new Map<string, AgentComposeYaml>();
  if (versionIds.length === 0) return contents;

  const db = globalThis.services.db;
  const versions = await db
    .select({
      id: agentComposeVersions.id,
      content: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .where(inArray(agentComposeVersions.id, versionIds));

  for (const v of versions) {
    contents.set(v.id, v.content as AgentComposeYaml);
  }

  return contents;
}
