import {
  MODEL_PROVIDER_TYPES,
  areProvidersCompatible,
  normalizeRunModelId,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";

function isKnownModelProvider(
  value: string | null | undefined,
): value is ModelProviderType {
  return (
    value !== null &&
    value !== undefined &&
    Object.hasOwn(MODEL_PROVIDER_TYPES, value)
  );
}

/**
 * Return the vendor/model stem used for chat session continuity.
 *
 * Model IDs may be provider-qualified (for example, anthropic/claude-opus),
 * while the session family is the first part of the canonical model ID
 * (claude, gpt, glm, ...). This intentionally treats model variants in one
 * family as compatible while keeping different families isolated.
 */
function chatSessionModelFamily(model: string): string {
  const normalized = normalizeRunModelId(model.trim()).toLowerCase();
  const modelName = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  return modelName.split(/[-_.]/, 1)[0] ?? modelName;
}

export function shouldStartNewChatSession(args: {
  readonly latestModel: string | null | undefined;
  readonly nextModel: string | null;
  readonly latestModelProvider?: string | null;
  readonly nextModelProvider?: string | null;
  readonly latestCliAgentType?: string | null;
  readonly nextCliAgentType?: string | null;
}): boolean {
  if (
    args.latestCliAgentType &&
    args.nextCliAgentType &&
    args.latestCliAgentType !== args.nextCliAgentType
  ) {
    return true;
  }
  if (
    isKnownModelProvider(args.latestModelProvider) &&
    isKnownModelProvider(args.nextModelProvider) &&
    !areProvidersCompatible(args.latestModelProvider, args.nextModelProvider)
  ) {
    return true;
  }
  if (
    args.latestModel === undefined ||
    args.latestModel === null ||
    args.nextModel === null
  ) {
    return false;
  }

  return (
    chatSessionModelFamily(args.latestModel) !==
    chatSessionModelFamily(args.nextModel)
  );
}

export async function canReuseChatSessionForModelRoute(args: {
  readonly db: Db | ReadonlyDb;
  readonly threadId: string;
  readonly sessionId: string;
  readonly nextModel: string | null;
  readonly nextModelProvider: string | null | undefined;
  readonly nextCliAgentType: string | null | undefined;
}): Promise<boolean> {
  const [previous] = await args.db
    .select({
      selectedModel: zeroRuns.selectedModel,
      modelProvider: zeroRuns.modelProvider,
      cliAgentType: conversations.cliAgentType,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(conversations, eq(conversations.id, agentSessions.conversationId))
    .where(
      and(
        eq(zeroRuns.chatThreadId, args.threadId),
        sql`${agentRuns.result}->>'agentSessionId' = ${args.sessionId}`,
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return (
    !previous ||
    !shouldStartNewChatSession({
      latestModel: previous.selectedModel,
      nextModel: args.nextModel,
      latestModelProvider: previous.modelProvider,
      nextModelProvider: args.nextModelProvider,
      latestCliAgentType: previous.cliAgentType,
      nextCliAgentType: args.nextCliAgentType,
    })
  );
}
