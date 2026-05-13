import { and, eq } from "drizzle-orm";
import {
  MODEL_PROVIDER_TYPES,
  areProvidersCompatible,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { resolveRuntimeFramework } from "../../infra/run/utils/resolve-runtime-framework";
import { logger } from "../../shared/logger";
import { resolveModelRoute } from "./resolve-model-provider";

const log = logger("zero:session-model-compatibility");

interface SessionModelSignature {
  modelProvider: string | undefined;
  selectedModel: string | undefined;
}

function normalize(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function isKnownProvider(value: string): value is ModelProviderType {
  return value in MODEL_PROVIDER_TYPES;
}

function selectedModelForRoute(
  route: Awaited<ReturnType<typeof resolveModelRoute>>,
): string | undefined {
  return route.provider.type === "vm0"
    ? route.model.canonical
    : route.model.selected;
}

function areSessionModelSignaturesCompatible(
  previous: SessionModelSignature,
  current: SessionModelSignature,
): boolean {
  if (
    previous.modelProvider &&
    current.modelProvider &&
    isKnownProvider(previous.modelProvider) &&
    isKnownProvider(current.modelProvider) &&
    !areProvidersCompatible(previous.modelProvider, current.modelProvider)
  ) {
    return false;
  }

  if (
    previous.selectedModel &&
    current.selectedModel &&
    previous.selectedModel !== current.selectedModel
  ) {
    return false;
  }

  return true;
}

async function getSessionModelSignature(
  sessionId: string,
  userId: string,
): Promise<SessionModelSignature | undefined> {
  const [row] = await globalThis.services.db
    .select({
      modelProvider: zeroRuns.modelProvider,
      selectedModel: zeroRuns.selectedModel,
    })
    .from(agentSessions)
    .innerJoin(
      conversations,
      eq(agentSessions.conversationId, conversations.id),
    )
    .innerJoin(zeroRuns, eq(zeroRuns.id, conversations.runId))
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)),
    )
    .limit(1);

  if (!row) return undefined;
  return {
    modelProvider: normalize(row.modelProvider),
    selectedModel: normalize(row.selectedModel),
  };
}

async function getComposeFramework(params: {
  agentComposeId: string;
  orgId: string;
}): Promise<string | undefined> {
  const [compose] = await globalThis.services.db
    .select({ content: agentComposeVersions.content })
    .from(agentComposes)
    .innerJoin(
      agentComposeVersions,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(
      and(
        eq(agentComposes.id, params.agentComposeId),
        eq(agentComposes.orgId, params.orgId),
      ),
    )
    .limit(1);

  if (!compose) return undefined;
  return resolveRuntimeFramework({ agentCompose: compose.content });
}

async function getCurrentRunModelSignature(params: {
  orgId: string;
  userId: string;
  agentComposeId: string;
  modelProviderId?: string | null;
  modelProviderCredentialScope?: string | null;
  selectedModel?: string | null;
  explicitModelFirstModelSelection?: boolean;
}): Promise<SessionModelSignature | undefined> {
  const framework = await getComposeFramework({
    agentComposeId: params.agentComposeId,
    orgId: params.orgId,
  });
  if (!framework) return undefined;

  const useExplicitModel = params.explicitModelFirstModelSelection === true;
  const route = await resolveModelRoute({
    orgId: params.orgId,
    userId: params.userId,
    framework,
    modelProviderId: useExplicitModel
      ? normalize(params.modelProviderId)
      : undefined,
    modelProviderCredentialScope: useExplicitModel
      ? normalize(params.modelProviderCredentialScope)
      : undefined,
    selectedModelOverride: useExplicitModel
      ? normalize(params.selectedModel)
      : undefined,
  });

  return {
    modelProvider: route.provider.type,
    selectedModel: selectedModelForRoute(route),
  };
}

export async function canReuseSessionForRunModel(params: {
  sessionId: string;
  userId: string;
  orgId: string;
  agentComposeId: string;
  modelProviderId?: string | null;
  modelProviderCredentialScope?: string | null;
  selectedModel?: string | null;
  explicitModelFirstModelSelection?: boolean;
}): Promise<boolean> {
  try {
    const [previous, current] = await Promise.all([
      getSessionModelSignature(params.sessionId, params.userId),
      getCurrentRunModelSignature(params),
    ]);

    if (!previous || !current) return true;
    return areSessionModelSignaturesCompatible(previous, current);
  } catch (error) {
    log.warn("Failed to check session model compatibility", {
      sessionId: params.sessionId,
      userId: params.userId,
      orgId: params.orgId,
      agentComposeId: params.agentComposeId,
      error,
    });
    return true;
  }
}
