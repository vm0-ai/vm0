import { and, eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentSessions } from "../../db/schema/agent-session";
import { zeroAgents } from "../../db/schema/zero-agent";
import {
  zeroAgentSessions,
  type StoredChatMessage,
} from "../../db/schema/zero-agent-session";

/**
 * Read the headVersionId and updatedAt of a compose record.
 * Useful for verifying recompose behavior in tests.
 */
export async function getComposeHeadVersion(
  composeId: string,
): Promise<
  { headVersionId: string | null; updatedAt: Date | null } | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      headVersionId: agentComposes.headVersionId,
      updatedAt: agentComposes.updatedAt,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row;
}

/**
 * Read the head compose version content for a compose record.
 * Returns the resolved compose content stored in the version.
 */
export async function getTestComposeVersionContent(
  composeId: string,
): Promise<Record<string, unknown> | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      content: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return (row?.content as Record<string, unknown>) ?? null;
}

/**
 * Get the zero_agents UUID by org + agent name.
 */
export async function getTestZeroAgentId(
  orgId: string,
  name: string,
): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, name)))
    .limit(1);
  if (!row) {
    throw new Error(`Zero agent not found: org=${orgId} name=${name}`);
  }
  return row.id;
}

/**
 * Read a zero_agents row by org + agent name.
 */
export async function getTestZeroAgent(
  orgId: string,
  name: string,
): Promise<
  | {
      displayName: string | null;
      description: string | null;
      sound: string | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, name)))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Session / conversation assertions (migrated from api-test-helpers/agents.ts)
// ---------------------------------------------------------------------------

/**
 * Get chat messages for a zero_agent_sessions record.
 */
export async function getTestSessionChatMessages(
  sessionId: string,
): Promise<StoredChatMessage[]> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ chatMessages: zeroAgentSessions.chatMessages })
    .from(zeroAgentSessions)
    .where(eq(zeroAgentSessions.id, sessionId))
    .limit(1);
  return (row?.chatMessages ?? []) as StoredChatMessage[];
}

/**
 * Get an agent session with its conversation data.
 */
export async function getTestAgentSessionWithConversation(
  sessionId: string,
): Promise<
  | {
      id: string;
      userId: string;
      orgId: string;
      agentComposeId: string;
      conversationId: string | null;
      memoryName: string | null;
      chatMessages: StoredChatMessage[];
    }
  | undefined
> {
  initServices();
  const [session] = await globalThis.services.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!session) return undefined;

  const [zeroSession] = await globalThis.services.db
    .select({ chatMessages: zeroAgentSessions.chatMessages })
    .from(zeroAgentSessions)
    .where(eq(zeroAgentSessions.id, sessionId))
    .limit(1);

  return {
    id: session.id,
    userId: session.userId,
    orgId: session.orgId,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId ?? null,
    memoryName: session.memoryName ?? null,
    chatMessages: (zeroSession?.chatMessages ?? []) as StoredChatMessage[],
  };
}

/**
 * Get the agent compose name by compose ID.
 */
export async function getTestAgentComposeName(
  composeId: string,
): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row!.name;
}
