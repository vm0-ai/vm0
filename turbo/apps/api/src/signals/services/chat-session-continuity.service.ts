import {
  getFrameworkForType,
  getVm0ConcreteProviderType,
  isSupportedRunModel,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { conversations } from "@vm0/db/schema/conversation";
import { piThreadMessages } from "@vm0/db/schema/pi-thread-message";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, sql } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";
import { isPiEdgeLoopRoute, PI_CHAT_SESSION_FRAMEWORK } from "./pi-edge-config";
import { isWebChatTriggerSource } from "./zero-chat-trigger-source.service";

export interface ChatThreadSessionRoute {
  readonly selectedModel: string | null;
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly framework: string | null;
}

export function effectiveChatThreadSessionRoute(args: {
  readonly route: ChatThreadSessionRoute;
  readonly triggerSource: TriggerSource | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
}): ChatThreadSessionRoute {
  return args.triggerSource !== undefined &&
    isWebChatTriggerSource(args.triggerSource) &&
    isFeatureEnabled(FeatureSwitchKey.PiLoop, args.featureSwitchContext) &&
    args.route.framework === "codex" &&
    isPiEdgeLoopRoute(args.route)
    ? { ...args.route, framework: PI_CHAT_SESSION_FRAMEWORK }
    : args.route;
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
  readonly cloudBrowserEnabled: boolean;
}

interface HistoricalThreadSession {
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly framework: string | null;
  readonly selectedModel: string | null;
}

interface SessionRunRoute {
  readonly runId: string;
  readonly cliAgentType: string | null;
  readonly selectedModel: string | null;
  readonly modelProvider: string | null;
}

function shouldStartNewChatSession(args: {
  readonly latestFramework: string | null;
  readonly nextFramework: string | null;
  readonly latestModel: string | null;
  readonly nextModel: string | null;
}): boolean {
  if (args.latestFramework !== args.nextFramework) {
    return true;
  }
  if (args.latestFramework !== "codex") {
    return false;
  }
  const latestProvider = codexSessionHistoryProvider(args.latestModel);
  const nextProvider = codexSessionHistoryProvider(args.nextModel);
  return (
    latestProvider !== null &&
    nextProvider !== null &&
    latestProvider !== nextProvider
  );
}

function codexSessionHistoryProvider(
  model: string | null,
): ModelProviderType | null {
  if (model === null || !isSupportedRunModel(model)) {
    return null;
  }
  const provider = getVm0ConcreteProviderType(model);
  return getFrameworkForType(provider) === "codex" ? provider : null;
}

async function runUsesPiFramework(args: {
  readonly db: Db | ReadonlyDb;
  readonly runId: string;
}): Promise<boolean> {
  // Completed Pi turns persist transcript rows instead of a CLI conversation.
  // Before the first Pi message arrives, the active standby/cold-start job is
  // the durable framework marker for the bound run.
  const [message] = await args.db
    .select({ runId: piThreadMessages.runId })
    .from(piThreadMessages)
    .where(eq(piThreadMessages.runId, args.runId))
    .limit(1);
  if (message) {
    return true;
  }
  const [job] = await args.db
    .select({ runId: runnerJobQueue.runId })
    .from(runnerJobQueue)
    .where(
      and(
        eq(runnerJobQueue.runId, args.runId),
        sql`${runnerJobQueue.executionContext}->>'piExecutionMode'
          IN ('standby', 'cold-start')`,
      ),
    )
    .limit(1);
  return job !== undefined;
}

async function sessionFramework(args: {
  readonly db: Db | ReadonlyDb;
  readonly runId: string | null;
  readonly cliAgentType: string | null;
  readonly selectedModel: string | null;
  readonly modelProvider: string | null;
}): Promise<string | null> {
  if (
    args.runId !== null &&
    (await runUsesPiFramework({ db: args.db, runId: args.runId }))
  ) {
    return PI_CHAT_SESSION_FRAMEWORK;
  }
  if (args.cliAgentType !== null) {
    return args.cliAgentType;
  }
  const provider = modelProviderTypeSchema.safeParse(args.modelProvider);
  if (!provider.success) {
    return null;
  }
  const concreteProvider =
    provider.data === "vm0" && isSupportedRunModel(args.selectedModel)
      ? getVm0ConcreteProviderType(args.selectedModel)
      : provider.data;
  return getFrameworkForType(concreteProvider);
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
      cliAgentType: conversations.cliAgentType,
      selectedModel: zeroRuns.selectedModel,
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
    framework: row.cliAgentType,
    selectedModel: row.selectedModel,
  };
}

async function latestSessionRunRoute(args: {
  readonly db: Db | ReadonlyDb;
  readonly sessionId: string;
}): Promise<SessionRunRoute | null> {
  const [row] = await args.db
    .select({
      runId: agentRuns.id,
      cliAgentType: conversations.cliAgentType,
      selectedModel: zeroRuns.selectedModel,
      modelProvider: zeroRuns.modelProvider,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .leftJoin(conversations, eq(conversations.runId, agentRuns.id))
    .where(eq(agentRuns.sessionId, args.sessionId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row ?? null;
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
      routeRunId: chatThreads.agentSessionRunId,
      selectedModel: zeroRuns.selectedModel,
      modelProvider: zeroRuns.modelProvider,
      cliAgentType: conversations.cliAgentType,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
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
    const previousFramework = await sessionFramework({
      db: args.db,
      runId: latestRoute?.runId ?? thread.routeRunId,
      cliAgentType: latestRoute?.cliAgentType ?? thread.cliAgentType,
      selectedModel: latestRoute?.selectedModel ?? thread.selectedModel,
      modelProvider: latestRoute?.modelProvider ?? thread.modelProvider,
    });
    const rotate = shouldStartNewChatSession({
      latestFramework: previousFramework,
      nextFramework: args.route.framework,
      latestModel: latestRoute?.selectedModel ?? thread.selectedModel,
      nextModel: args.route.selectedModel,
    });
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

  const rotate = shouldStartNewChatSession({
    latestFramework: historical.framework,
    nextFramework: args.route.framework,
    latestModel: historical.selectedModel,
    nextModel: args.route.selectedModel,
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
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
  };
}
