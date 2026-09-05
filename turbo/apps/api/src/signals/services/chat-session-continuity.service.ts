import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";
import {
  canReuseSession,
  type SessionExecutionIdentity,
} from "./session-compatibility";

export type ChatThreadSessionRoute = SessionExecutionIdentity;

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
  readonly cloudBrowserEnabled: boolean;
}

interface HistoricalThreadSession {
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly historylessConversation: boolean;
  readonly route: ChatThreadSessionRoute;
}

interface SessionRunRoute {
  readonly selectedModel: string | null;
}

function historylessConversationSql() {
  return sql`(
    ${conversations.id} IS NOT NULL
    AND ${conversations.cliAgentSessionHistory} IS NULL
    AND ${conversations.cliAgentSessionHistoryHash} IS NULL
  )`.mapWith(pgBooleanDecoder);
}

async function latestHistoricalThreadSession(args: {
  readonly db: Db | ReadonlyDb;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}): Promise<HistoricalThreadSession | null> {
  const [row] = await args.db
    .select({
      sessionId: agentSessions.id,
      conversationId: agentSessions.conversationId,
      selectedModel: agentRuns.selectedModel,
      cliAgentType: conversations.cliAgentType,
      historylessConversation: historylessConversationSql(),
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(conversations, eq(conversations.id, agentSessions.conversationId))
    .where(
      and(
        eq(agentRuns.chatThreadId, args.threadId),
        isNotNull(agentRuns.triggerSource),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
        eq(agentSessions.agentId, args.agentId),
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
    historylessConversation: row.historylessConversation,
    route: {
      selectedModel: row.selectedModel,
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
      selectedModel: agentRuns.selectedModel,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.sessionId, args.sessionId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row ?? null;
}

function boundThreadPreviousRoute(args: {
  readonly thread: ChatThreadSessionRoute;
  readonly latestRoute: SessionRunRoute | null;
}): ChatThreadSessionRoute {
  const { thread, latestRoute } = args;
  return {
    selectedModel: latestRoute?.selectedModel ?? thread.selectedModel,
    cliAgentType: thread.cliAgentType,
  };
}

export async function resolveChatThreadSession(args: {
  readonly db: Db | ReadonlyDb;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly route: ChatThreadSessionRoute;
}): Promise<ChatThreadSessionResolution> {
  const [thread] = await args.db
    .select({
      agentSessionId: chatThreads.agentSessionId,
      agentSessionRunId: chatThreads.agentSessionRunId,
      sessionId: agentSessions.id,
      conversationId: agentSessions.conversationId,
      selectedModel: agentRuns.selectedModel,
      routeRunId:
        sql`CASE WHEN ${agentRuns.triggerSource} IS NOT NULL THEN ${agentRuns.id} ELSE NULL END`.mapWith(
          nullableDriverValueDecoder(agentRuns.id),
        ),
      cliAgentType: conversations.cliAgentType,
      historylessConversation: historylessConversationSql(),
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    })
    .from(chatThreads)
    .leftJoin(
      agentSessions,
      and(
        eq(agentSessions.id, chatThreads.agentSessionId),
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.orgId, args.orgId),
        eq(agentSessions.agentId, args.agentId),
      ),
    )
    .leftJoin(conversations, eq(conversations.id, agentSessions.conversationId))
    .leftJoin(agentRuns, eq(agentRuns.id, chatThreads.agentSessionRunId))
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, args.agentId),
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
    const previousRoute = boundThreadPreviousRoute({
      thread,
      latestRoute,
    });
    const rotate =
      thread.historylessConversation ||
      !canReuseSession(previousRoute, args.route);
    return {
      sessionId: rotate ? undefined : thread.sessionId,
      action: rotate ? "rotated" : "reused",
      expected,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
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
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
    };
  }

  const rotate =
    historical.historylessConversation ||
    !canReuseSession(historical.route, args.route);
  return {
    sessionId: rotate ? undefined : historical.sessionId,
    action: rotate ? "rotated" : "adopted",
    expected: {
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      sessionId: historical.sessionId,
      conversationId: historical.conversationId,
    },
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
  };
}
