import {
  MODEL_PROVIDER_TYPES,
  areProvidersCompatible,
  normalizeRunModelId,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { conversations } from "@vm0/db/schema/conversation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";

export interface ChatThreadSessionRoute {
  readonly selectedModel: string | null;
  readonly modelProvider: string | null;
  readonly cliAgentType: string | null;
}

export type ChatThreadSessionResolutionAction =
  | "initialized"
  | "reused"
  | "adopted"
  | "rotated";

export interface ChatThreadSessionSnapshot {
  readonly agentSessionId: string | null;
  readonly agentSessionRunId: string | null;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
}

export interface ChatThreadSessionResolution {
  readonly sessionId: string | undefined;
  readonly action: ChatThreadSessionResolutionAction;
  readonly expected: ChatThreadSessionSnapshot;
}

interface HistoricalThreadSession {
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly route: ChatThreadSessionRoute;
}

interface SessionRunRoute {
  readonly selectedModel: string | null;
  readonly modelProvider: string | null;
}

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

function shouldStartNewChatSession(args: {
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

async function latestHistoricalThreadSession(args: {
  readonly db: Db | ReadonlyDb;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentComposeId: string;
}): Promise<HistoricalThreadSession | null> {
  const [row] = await args.db
    .select({
      sessionId: agentSessions.id,
      conversationId: agentSessions.conversationId,
      selectedModel: zeroRuns.selectedModel,
      modelProvider: zeroRuns.modelProvider,
      cliAgentType: conversations.cliAgentType,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(conversations, eq(conversations.id, agentSessions.conversationId))
    .where(
      and(
        eq(zeroRuns.chatThreadId, args.threadId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
        eq(agentSessions.agentComposeId, args.agentComposeId),
        eq(
          sql`${agentRuns.result}->>'agentSessionId'`,
          sql`${agentSessions.id}::text`,
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    sessionId: row.sessionId,
    conversationId: row.conversationId,
    route: {
      selectedModel: row.selectedModel,
      modelProvider: row.modelProvider,
      cliAgentType: row.cliAgentType,
    },
  };
}

async function latestSessionRunRoute(args: {
  readonly db: Db | ReadonlyDb;
  readonly sessionId: string;
}): Promise<SessionRunRoute | null> {
  const [row] = await args.db
    .select({
      selectedModel: zeroRuns.selectedModel,
      modelProvider: zeroRuns.modelProvider,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.sessionId, args.sessionId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row ?? null;
}

function shouldRotateCanonicalSession(args: {
  readonly previousRoute: ChatThreadSessionRoute;
  readonly nextRoute: ChatThreadSessionRoute;
}): boolean {
  return shouldStartNewChatSession({
    latestModel: args.previousRoute.selectedModel,
    nextModel: args.nextRoute.selectedModel,
    latestModelProvider: args.previousRoute.modelProvider,
    nextModelProvider: args.nextRoute.modelProvider,
    latestCliAgentType: args.previousRoute.cliAgentType,
    nextCliAgentType: args.nextRoute.cliAgentType,
  });
}

export async function resolveChatThreadSession(args: {
  readonly db: Db | ReadonlyDb;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentComposeId: string;
  readonly route: ChatThreadSessionRoute;
}): Promise<ChatThreadSessionResolution> {
  const [thread] = await args.db
    .select({
      agentSessionId: chatThreads.agentSessionId,
      agentSessionRunId: chatThreads.agentSessionRunId,
      sessionId: agentSessions.id,
      conversationId: agentSessions.conversationId,
      selectedModel: zeroRuns.selectedModel,
      modelProvider: zeroRuns.modelProvider,
      routeRunId: zeroRuns.id,
      cliAgentType: conversations.cliAgentType,
    })
    .from(chatThreads)
    .leftJoin(
      agentSessions,
      and(
        eq(agentSessions.id, chatThreads.agentSessionId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
        eq(agentSessions.agentComposeId, args.agentComposeId),
      ),
    )
    .leftJoin(conversations, eq(conversations.id, agentSessions.conversationId))
    .leftJoin(zeroRuns, eq(zeroRuns.id, chatThreads.agentSessionRunId))
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentComposeId, args.agentComposeId),
      ),
    )
    .limit(1);
  if (!thread) {
    throw new Error("Chat thread not found while resolving session binding");
  }

  if (thread.agentSessionId !== null && thread.sessionId !== null) {
    const expected = {
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      sessionId: thread.sessionId,
      conversationId: thread.conversationId,
    };
    const latestRoute =
      thread.routeRunId === null
        ? await latestSessionRunRoute({
            db: args.db,
            sessionId: thread.sessionId,
          })
        : null;
    const rotate = shouldRotateCanonicalSession({
      previousRoute: {
        selectedModel: latestRoute?.selectedModel ?? thread.selectedModel,
        modelProvider: latestRoute?.modelProvider ?? thread.modelProvider,
        cliAgentType: thread.cliAgentType,
      },
      nextRoute: args.route,
    });
    return {
      sessionId: rotate ? undefined : thread.sessionId,
      action: rotate ? "rotated" : "reused",
      expected,
    };
  }

  const historical = await latestHistoricalThreadSession(args);
  if (!historical) {
    return {
      sessionId: undefined,
      action: "initialized",
      expected: {
        agentSessionId: thread.agentSessionId,
        agentSessionRunId: thread.agentSessionRunId,
        sessionId: null,
        conversationId: null,
      },
    };
  }

  const rotate = shouldRotateCanonicalSession({
    previousRoute: historical.route,
    nextRoute: args.route,
  });
  return {
    sessionId: rotate ? undefined : historical.sessionId,
    action: rotate ? "rotated" : "adopted",
    expected: {
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      sessionId: historical.sessionId,
      conversationId: historical.conversationId,
    },
  };
}
