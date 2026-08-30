import {
  MODEL_PROVIDER_TYPES,
  areProvidersCompatible,
  isCustomGatewayProviderType,
  normalizeRunModelId,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import type { Db, ReadonlyDb } from "../external/db";
import { hasIncompatibleBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";

export interface ChatThreadSessionRoute {
  readonly selectedModel: string | null;
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
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
  readonly cloudBrowserEnabled: boolean;
}

interface HistoricalThreadSession {
  readonly sessionId: string;
  readonly conversationId: string | null;
  readonly historylessConversation: boolean;
  readonly route: ChatThreadSessionRoute;
  readonly routeRunCreatedAt: Date;
}

interface SessionRunRoute {
  readonly selectedModel: string | null;
  readonly modelProvider: string | null;
  readonly modelProviderId: string | null;
  readonly modelRuntimeProvider: string | null;
  readonly modelRuntimeModel: string | null;
  readonly createdAt: Date;
}

function historylessConversationSql() {
  return sql`(
    ${conversations.id} IS NOT NULL
    AND ${conversations.cliAgentSessionHistory} IS NULL
    AND ${conversations.cliAgentSessionHistoryHash} IS NULL
  )`.mapWith(pgBooleanDecoder);
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
  readonly agentId: string;
}): Promise<HistoricalThreadSession | null> {
  const [row] = await args.db
    .select({
      sessionId: agentSessions.id,
      conversationId: agentSessions.conversationId,
      selectedModel: agentRuns.selectedModel,
      modelProvider: agentRuns.modelProvider,
      modelProviderId: agentRuns.modelProviderId,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      cliAgentType: conversations.cliAgentType,
      historylessConversation: historylessConversationSql(),
      routeRunCreatedAt: agentRuns.createdAt,
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
      modelProvider: row.modelProvider,
      modelProviderId: row.modelProviderId,
      modelRuntimeProvider: row.modelRuntimeProvider,
      modelRuntimeModel: row.modelRuntimeModel,
      cliAgentType: row.cliAgentType,
    },
    routeRunCreatedAt: row.routeRunCreatedAt,
  };
}

async function latestSessionRunRoute(args: {
  readonly db: Db | ReadonlyDb;
  readonly sessionId: string;
}): Promise<SessionRunRoute | null> {
  const [row] = await args.db
    .select({
      selectedModel: agentRuns.selectedModel,
      modelProvider: agentRuns.modelProvider,
      modelProviderId: agentRuns.modelProviderId,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      createdAt: agentRuns.createdAt,
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

async function customSurfaceRouteChanged(args: {
  readonly db: Db | ReadonlyDb;
  readonly orgId: string;
  readonly previousModelProviderId: string | null;
  readonly nextModelProviderId: string | null;
  readonly previousRunCreatedAt: Date | null;
}): Promise<boolean> {
  const candidateSurfaceIds = [
    args.previousModelProviderId,
    args.nextModelProviderId,
  ].filter((id): id is string => {
    return id !== null;
  });
  if (candidateSurfaceIds.length === 0) {
    return false;
  }
  const surfaces = await args.db
    .select({
      surfaceUpdatedAt: modelProviderSurfaces.updatedAt,
      connectionUpdatedAt: modelProviderConnections.updatedAt,
    })
    .from(modelProviderSurfaces)
    .innerJoin(
      modelProviderConnections,
      eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
    )
    .where(
      and(
        inArray(modelProviderSurfaces.id, candidateSurfaceIds),
        eq(modelProviderConnections.orgId, args.orgId),
      ),
    );
  if (args.previousModelProviderId !== args.nextModelProviderId) {
    return surfaces.length > 0;
  }
  const [surface] = surfaces;
  return (
    surface !== undefined &&
    args.previousRunCreatedAt !== null &&
    (surface.surfaceUpdatedAt > args.previousRunCreatedAt ||
      surface.connectionUpdatedAt > args.previousRunCreatedAt)
  );
}

/**
 * Whether either side of a route change can be a custom gateway surface.
 *
 * The dedicated `custom-*` types say so directly. The two Vercel adapter types
 * still count because runs recorded before migration `0948` used them for
 * custom surfaces too, and the rows whose surface id no longer resolves were
 * deliberately left unreclassified.
 */
function customSurfaceRouteMayBeInUse(args: {
  readonly previousRoute: ChatThreadSessionRoute;
  readonly nextRoute: ChatThreadSessionRoute;
}): boolean {
  return [args.previousRoute.modelProvider, args.nextRoute.modelProvider].some(
    (provider) => {
      return (
        provider === "vercel-ai-gateway" ||
        provider === "vercel-ai-gateway-codex" ||
        (isKnownModelProvider(provider) &&
          isCustomGatewayProviderType(provider))
      );
    },
  );
}

function shouldRotateCanonicalSession(args: {
  readonly previousRoute: ChatThreadSessionRoute;
  readonly nextRoute: ChatThreadSessionRoute;
}): boolean {
  if (
    hasIncompatibleBuiltInModelRuntimeRoute({
      previous: args.previousRoute,
      next: args.nextRoute,
    })
  ) {
    return true;
  }
  const providerIdChanged =
    args.previousRoute.modelProviderId !== args.nextRoute.modelProviderId;
  if (providerIdChanged && customSurfaceRouteMayBeInUse(args)) {
    // Once a custom gateway connection is deleted, the surface row can no
    // longer prove that the previous route was custom, so the provider
    // identity must remain part of the canonical continuity boundary.
    return true;
  }
  return shouldStartNewChatSession({
    latestModel: args.previousRoute.selectedModel,
    nextModel: args.nextRoute.selectedModel,
    latestModelProvider: args.previousRoute.modelProvider,
    nextModelProvider: args.nextRoute.modelProvider,
    latestCliAgentType: args.previousRoute.cliAgentType,
    nextCliAgentType: args.nextRoute.cliAgentType,
  });
}

async function shouldRotateResolvedSession(args: {
  readonly db: Db | ReadonlyDb;
  readonly orgId: string;
  readonly historylessConversation: boolean;
  readonly previousRoute: ChatThreadSessionRoute;
  readonly nextRoute: ChatThreadSessionRoute;
  readonly previousRunCreatedAt: Date | null;
}): Promise<boolean> {
  if (args.historylessConversation) {
    return true;
  }
  const routeConfigurationChanged = await customSurfaceRouteChanged({
    db: args.db,
    orgId: args.orgId,
    previousModelProviderId: args.previousRoute.modelProviderId,
    nextModelProviderId: args.nextRoute.modelProviderId,
    previousRunCreatedAt: args.previousRunCreatedAt,
  });
  return routeConfigurationChanged
    ? true
    : shouldRotateCanonicalSession({
        previousRoute: args.previousRoute,
        nextRoute: args.nextRoute,
      });
}

function boundThreadPreviousRoute(args: {
  readonly thread: ChatThreadSessionRoute;
  readonly latestRoute: SessionRunRoute | null;
}): ChatThreadSessionRoute {
  const { thread, latestRoute } = args;
  return {
    selectedModel: latestRoute?.selectedModel ?? thread.selectedModel,
    modelProvider: latestRoute?.modelProvider ?? thread.modelProvider,
    modelProviderId: latestRoute?.modelProviderId ?? thread.modelProviderId,
    modelRuntimeProvider:
      latestRoute === null
        ? thread.modelRuntimeProvider
        : latestRoute.modelRuntimeProvider,
    modelRuntimeModel:
      latestRoute === null
        ? thread.modelRuntimeModel
        : latestRoute.modelRuntimeModel,
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
      modelProvider: agentRuns.modelProvider,
      modelProviderId: agentRuns.modelProviderId,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      routeRunId:
        sql`CASE WHEN ${agentRuns.triggerSource} IS NOT NULL THEN ${agentRuns.id} ELSE NULL END`.mapWith(
          nullableDriverValueDecoder(agentRuns.id),
        ),
      routeRunCreatedAt: agentRuns.createdAt,
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
    const rotate = await shouldRotateResolvedSession({
      db: args.db,
      orgId: args.orgId,
      historylessConversation: thread.historylessConversation,
      previousRoute,
      nextRoute: args.route,
      previousRunCreatedAt:
        latestRoute?.createdAt ?? thread.routeRunCreatedAt ?? null,
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

  const rotate = await shouldRotateResolvedSession({
    db: args.db,
    orgId: args.orgId,
    historylessConversation: historical.historylessConversation,
    previousRoute: historical.route,
    nextRoute: args.route,
    previousRunCreatedAt: historical.routeRunCreatedAt,
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
