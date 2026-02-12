import { eq, inArray } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { getUserEmail } from "../auth/get-user-email";
import { getEmailSharedAgents } from "./permission-service";
import type { AgentComposeYaml } from "../../types/agent-compose";

interface UserAgent {
  composeId: string;
  agentName: string;
  headVersionId: string | null;
}

/**
 * Fetch all agents accessible to a user (own + email-shared).
 * Shared agents are returned with `scopeSlug/name` format for agentName.
 *
 * Note: This always includes shared agents, unlike `composes/list` which
 * only includes them when no `?scope=` param is provided. This is intentional
 * — routes like `required-env` and `missing-secrets` need the full picture
 * regardless of scope filtering.
 */
export async function getUserAgents(userId: string): Promise<UserAgent[]> {
  const db = globalThis.services.db;

  const ownAgents = await db
    .select({
      composeId: agentComposes.id,
      agentName: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.userId, userId));

  const userEmail = await getUserEmail(userId);
  const sharedAgents = await getEmailSharedAgents(userId, userEmail);

  return [
    ...ownAgents,
    ...sharedAgents.map((a) => ({
      composeId: a.id,
      agentName: `${a.scopeSlug}/${a.name}`,
      headVersionId: a.headVersionId,
    })),
  ];
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
