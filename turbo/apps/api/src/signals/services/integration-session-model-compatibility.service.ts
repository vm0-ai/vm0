import {
  MODEL_PROVIDER_TYPES,
  areProvidersCompatible,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { desc, eq } from "drizzle-orm";

import type { Db, ReadonlyDb } from "../external/db";

interface IntegrationSessionModelSignature {
  readonly modelProvider: string | null;
  readonly selectedModel: string | null;
}

interface IntegrationRunModelRoute {
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
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

async function latestIntegrationSessionModelSignature(
  db: Db | ReadonlyDb,
  sessionId: string,
): Promise<IntegrationSessionModelSignature | null> {
  const [previousRun] = await db
    .select({
      modelProvider: zeroRuns.modelProvider,
      selectedModel: zeroRuns.selectedModel,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.sessionId, sessionId))
    .orderBy(desc(agentRuns.createdAt))
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

  const previous = await latestIntegrationSessionModelSignature(
    args.db,
    args.sessionId,
  );
  return (
    !previous ||
    areIntegrationSessionModelsCompatible(previous, args.modelRoute)
  );
}
