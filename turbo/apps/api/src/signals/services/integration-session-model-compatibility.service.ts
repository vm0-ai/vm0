import {
  MODEL_PROVIDER_TYPES,
  areProvidersCompatible,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";

interface IntegrationSessionModelSignature {
  readonly modelProvider: string | null;
  readonly selectedModel: string | null;
  readonly cliAgentType: string;
}

interface IntegrationRunModelRoute {
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly cliAgentType: string;
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

function areIntegrationSessionModelsCompatible(
  previous: IntegrationSessionModelSignature,
  current: IntegrationRunModelRoute,
): boolean {
  if (previous.cliAgentType !== current.cliAgentType) {
    return false;
  }

  if (
    isKnownModelProvider(previous.modelProvider) &&
    isKnownModelProvider(current.modelProviderType) &&
    !areProvidersCompatible(previous.modelProvider, current.modelProviderType)
  ) {
    return false;
  }

  return !(
    previous.selectedModel &&
    current.selectedModel &&
    previous.selectedModel !== current.selectedModel
  );
}

async function currentIntegrationSessionModelSignature(
  db: Db | ReadonlyDb,
  sessionId: string,
): Promise<IntegrationSessionModelSignature | null> {
  const [previousRun] = await db
    .select({
      modelProvider: zeroRuns.modelProvider,
      selectedModel: zeroRuns.selectedModel,
      cliAgentType: conversations.cliAgentType,
    })
    .from(agentSessions)
    .innerJoin(
      conversations,
      eq(conversations.id, agentSessions.conversationId),
    )
    .innerJoin(agentRuns, eq(agentRuns.id, conversations.runId))
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  return previousRun ?? null;
}

export async function canReuseIntegrationSessionForModelRoute(args: {
  readonly db: Db | ReadonlyDb;
  readonly sessionId: string;
  readonly modelRoute: IntegrationRunModelRoute | null | undefined;
}): Promise<boolean> {
  if (!args.modelRoute) {
    return true;
  }

  const previous = await currentIntegrationSessionModelSignature(
    args.db,
    args.sessionId,
  );
  return (
    !previous ||
    areIntegrationSessionModelsCompatible(previous, args.modelRoute)
  );
}
