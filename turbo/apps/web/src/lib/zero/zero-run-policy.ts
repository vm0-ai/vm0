import { eq, and, count, gt, or } from "drizzle-orm";
import { env } from "../../env";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  concurrentRunLimit,
  forbidden,
  isNoModelProvider,
} from "@vm0/api-services/errors";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderFramework,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { canAccessCompose } from "../infra/agent/compose-access";
import {
  resolveRuntimeFramework,
  validateFrameworkApiKey,
} from "../infra/run/utils";
import { logger } from "../shared/logger";
import {
  MODEL_PROVIDER_ENV_VARS,
  resolveModelRoute,
} from "./context/resolve-model-provider";
import {
  checkOrgCredits,
  type CheckOrgCreditsOptions,
} from "./credit/check-org-credits";
import type { Database } from "../../types/global";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { AgentComposeYaml } from "../infra/agent-compose/types";

const log = logger("zero:run-policy");

// Defense-in-depth: exclude pending runs older than this from concurrency check.
// The cleanup-sandboxes cron job already transitions pending runs to "timeout" after 5 minutes,
// so this TTL only matters if the cron job fails to run.
export const PENDING_RUN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Concurrent run limits by org tier */
const TIER_CONCURRENCY_LIMITS: Record<OrgTier, number> = {
  free: 1,
  pro: 2,
  team: 10,
};

function getConcurrencyLimitForTier(tier: OrgTier): number {
  return TIER_CONCURRENCY_LIMITS[tier];
}

/**
 * Get the effective concurrency limit for an org tier.
 * Tier-based limit is the baseline; env var acts as a global cap.
 * Returns 0 for unlimited.
 */
export function getEffectiveConcurrencyLimit(orgTier: OrgTier): number {
  const tierLimit = getConcurrencyLimitForTier(orgTier);
  const envCap = env().CONCURRENT_RUN_LIMIT_CAP;
  if (envCap === 0) return 0;
  if (envCap !== undefined && !isNaN(envCap))
    return Math.min(tierLimit, envCap);
  return tierLimit;
}

/**
 * Check if org has reached concurrent run limit
 *
 * @param orgId Clerk org ID to check
 * @param orgTier Org tier for tier-based limit (default: "free")
 * @param db Optional database instance (for use within transactions)
 * @throws ConcurrentRunLimitError if limit exceeded
 */
export async function checkRunConcurrencyLimit(
  orgId: string,
  orgTier: OrgTier = "free",
  db?: Database,
): Promise<void> {
  const effectiveLimit = getEffectiveConcurrencyLimit(orgTier);

  // Skip check if limit is 0 (no limit)
  if (effectiveLimit === 0) {
    return;
  }

  const queryDb = db ?? globalThis.services.db;

  // Count active runs: all "running" runs + "pending" runs within TTL
  const staleThreshold = new Date(Date.now() - PENDING_RUN_TTL_MS);

  const [result] = await queryDb
    .select({ count: count() })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        or(
          eq(agentRuns.status, "running"),
          and(
            eq(agentRuns.status, "pending"),
            gt(agentRuns.createdAt, staleThreshold),
          ),
        ),
      ),
    );

  const activeRunCount = Number(result?.count ?? 0);

  if (activeRunCount >= effectiveLimit) {
    log.debug(
      `Org ${orgId} has ${activeRunCount} active runs, limit is ${effectiveLimit}`,
    );
    throw concurrentRunLimit();
  }
}

export function authorizeCompose(
  userId: string,
  orgId: string,
  compose: { id: string; userId: string; orgId: string },
): void {
  const hasAccess = canAccessCompose(userId, orgId, compose);
  if (!hasAccess) {
    throw forbidden("You do not have permission to access this agent");
  }
}

/**
 * Validate compose requirements for new runs.
 *
 * Skipped when resuming from checkpoint or continuing a session.
 *
 * `providerType`, when supplied, lets the API-key validator accept a
 * provider-supplied secret in lieu of a compose-level declaration.
 */
export async function validateComposeRequirements(
  composeContent: AgentComposeYaml,
  providerType?: ModelProviderType | null,
): Promise<void> {
  if (!composeContent?.agents) {
    return;
  }
  validateFrameworkApiKey(composeContent, providerType);
}

/**
 * Resolve the provider type that admission checks should treat as the
 * effective key source for this run.
 *
 * This intentionally reuses the dispatch route resolver so credit admission
 * and sandbox dispatch cannot drift on provider/default precedence. It returns
 * null only when no provider route exists; explicit compose env validation
 * happens separately in `checkModelProviderConfigured`.
 */
interface ResolvedAdmissionProvider {
  providerType: ModelProviderType | null;
  providerFramework: ModelProviderFramework | null;
}

async function resolveProviderForAdmission(params: {
  orgId: string;
  userId: string;
  modelProvider?: string | null;
  modelProviderId?: string | null;
  modelProviderCredentialScope?: string | null;
  selectedModelOverride?: string | null;
  composeFramework: string;
}): Promise<ResolvedAdmissionProvider> {
  if (params.modelProvider && !(params.modelProvider in MODEL_PROVIDER_TYPES)) {
    return { providerType: null, providerFramework: null };
  }
  try {
    const route = await resolveModelRoute({
      orgId: params.orgId,
      userId: params.userId,
      framework: params.composeFramework,
      explicitModelProvider: params.modelProvider ?? undefined,
      modelProviderId: params.modelProviderId ?? undefined,
      modelProviderCredentialScope:
        params.modelProviderCredentialScope ?? undefined,
      selectedModelOverride: params.selectedModelOverride ?? undefined,
    });
    return {
      providerType: route.provider.type,
      providerFramework: route.framework,
    };
  } catch (error) {
    if (isNoModelProvider(error)) {
      return { providerType: null, providerFramework: null };
    }
    throw error;
  }
}

interface RunAdmissionContext {
  orgId: string;
  userId: string;
  providerType: ModelProviderType | null;
  providerFramework?: ModelProviderFramework | null;
}

export async function resolveRunAdmissionContext(params: {
  orgId: string;
  userId: string;
  modelProvider?: string | null;
  modelProviderId?: string | null;
  modelProviderCredentialScope?: string | null;
  selectedModelOverride?: string | null;
  composeFramework: string;
}): Promise<RunAdmissionContext> {
  const provider = await resolveProviderForAdmission(params);
  return {
    orgId: params.orgId,
    userId: params.userId,
    providerType: provider.providerType,
    providerFramework: provider.providerFramework,
  };
}

/**
 * Credit admission for an already-resolved run context.
 *
 * vm0-managed providers spend vm0 credits and must pass the org/member credit
 * gate. BYOK and personal providers are paid outside vm0, so they skip this
 * check. Callers must resolve the provider from the current run context first;
 * raw `modelProvider` strings are not sufficient because UI calls can carry
 * only `modelProviderId`.
 */
export async function checkOrgCreditsForRunAdmission(
  context: RunAdmissionContext,
  db: Database = globalThis.services.db,
  options: CheckOrgCreditsOptions = {},
): Promise<void> {
  if (context.providerType !== "vm0") return;

  await checkOrgCredits(context.orgId, context.userId, db, options);
}

/**
 * Pre-flight check: ensure a model provider is configured.
 *
 * Skips when compose has explicit env vars. Otherwise this uses the same
 * central route resolver as dispatch so pre-flight configuration checks and
 * runtime materialization agree on provider/default semantics.
 */
export async function checkModelProviderConfigured(
  orgId: string,
  userId: string,
  modelProvider: string | null | undefined,
  composeContent: AgentComposeYaml,
  selectedModelOverride?: string | null,
  modelProviderId?: string | null,
  modelProviderCredentialScope?: string | null,
): Promise<void> {
  const firstAgent = composeContent.agents
    ? Object.values(composeContent.agents)[0]
    : undefined;
  const framework = resolveRuntimeFramework({ agentCompose: composeContent });

  const hasExplicitConfig = MODEL_PROVIDER_ENV_VARS.some((v) => {
    return firstAgent?.environment?.[v] !== undefined;
  });
  if (hasExplicitConfig) return;
  if (modelProvider && !(modelProvider in MODEL_PROVIDER_TYPES)) return;

  await resolveModelRoute({
    orgId,
    userId,
    framework,
    explicitModelProvider: modelProvider ?? undefined,
    modelProviderId: modelProviderId ?? undefined,
    modelProviderCredentialScope: modelProviderCredentialScope ?? undefined,
    selectedModelOverride: selectedModelOverride ?? undefined,
  });
}
