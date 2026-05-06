import { eq, and, count, gt, or } from "drizzle-orm";
import { env } from "../../env";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  concurrentRunLimit,
  forbidden,
  noModelProvider,
} from "@vm0/api-services/errors";
import {
  MODEL_PROVIDER_TYPES,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import { canAccessCompose } from "../infra/agent/compose-access";
import { validateFrameworkApiKey } from "../infra/run/utils";
import { logger } from "../shared/logger";
import { MODEL_PROVIDER_ENV_VARS } from "./context/resolve-model-provider";
import { checkOrgCredits } from "./credit/check-org-credits";
import {
  getOrgDefaultModelProvider,
  getOrgDefaultModelProviderType,
  getOrgAnyDefaultModelProvider,
  getOrgAnyDefaultModelProviderType,
  getModelProviderById,
  getUserDefaultModelProvider,
  getUserAnyDefaultModelProvider,
} from "./model-provider/model-provider-service";
import { isPersonalTierEligible } from "./personal-tier-gate";
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
 * effective key source for this run. Precedence:
 *   explicit override → explicit modelProviderId → personal-tier (gated) →
 *   org default for compose framework → any org default (cross-framework
 *   fallback).
 *
 * The cross-framework fallback implements Epic #11520's "provider's framework
 * wins" rule at the admission boundary: an org with only a codex provider
 * still admits a claude-code compose; the provider's framework propagates
 * downstream via `resolvedFramework` so dispatch launches the right binary.
 *
 * The personal-tier branch (Epic #11868) admits a user with only personal
 * providers — without it admission would throw `noModelProvider()` even
 * though the resolver downstream would have served them.
 *
 * Returns null only when the user has no personal tier (or it's gated off)
 * AND the org has no `isDefault: true` provider at all.
 */
async function resolveProviderTypeForAdmission(params: {
  orgId: string;
  userId: string;
  modelProvider?: string | null;
  modelProviderId?: string | null;
  composeFramework: string;
  preferPersonalProvider?: boolean;
}): Promise<ModelProviderType | null> {
  if (params.modelProvider && params.modelProvider in MODEL_PROVIDER_TYPES) {
    return params.modelProvider as ModelProviderType;
  }
  if (params.modelProviderId) {
    const row = await getModelProviderById(
      params.orgId,
      params.userId,
      params.modelProviderId,
    );
    return row?.type ?? null;
  }
  const personalEligible = await isPersonalTierEligible(
    params.orgId,
    params.userId,
    params.preferPersonalProvider,
  );
  if (personalEligible) {
    const userDef =
      (await getUserDefaultModelProvider(
        params.orgId,
        params.userId,
        params.composeFramework,
      )) ?? (await getUserAnyDefaultModelProvider(params.orgId, params.userId));
    if (userDef) return userDef.type;
  }
  const def =
    (await getOrgDefaultModelProvider(params.orgId, params.composeFramework)) ??
    (await getOrgAnyDefaultModelProvider(params.orgId));
  return def?.type ?? null;
}

interface RunAdmissionContext {
  orgId: string;
  userId: string;
  providerType: ModelProviderType | null;
}

export async function resolveRunAdmissionContext(params: {
  orgId: string;
  userId: string;
  modelProvider?: string | null;
  modelProviderId?: string | null;
  composeFramework: string;
  preferPersonalProvider?: boolean;
}): Promise<RunAdmissionContext> {
  return {
    orgId: params.orgId,
    userId: params.userId,
    providerType: await resolveProviderTypeForAdmission(params),
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
): Promise<void> {
  if (context.providerType !== "vm0") return;

  await checkOrgCredits(context.orgId, context.userId, db);
}

/**
 * Pre-flight check: ensure a model provider is configured.
 *
 * Skips when compose has explicit env vars, an explicit modelProvider param
 * is provided, or the framework doesn't use model providers.
 *
 * When `preferPersonalProvider` is on AND the personal feature switch is
 * enabled for the caller (Epic #11868), accepts a personal-tier provider
 * before falling through to the org chain — without this the admission
 * boundary would throw `noModelProvider()` for users who only have personal
 * providers, even though the resolver downstream would have served them.
 */
export async function checkModelProviderConfigured(
  orgId: string,
  userId: string,
  modelProvider: string | null | undefined,
  composeContent: AgentComposeYaml,
  preferPersonalProvider?: boolean,
): Promise<void> {
  if (modelProvider) return;

  const firstAgent = composeContent.agents
    ? Object.values(composeContent.agents)[0]
    : undefined;
  const framework = firstAgent?.framework || "claude-code";

  const hasExplicitConfig = MODEL_PROVIDER_ENV_VARS.some((v) => {
    return firstAgent?.environment?.[v] !== undefined;
  });
  if (hasExplicitConfig) return;

  if (await isPersonalTierEligible(orgId, userId, preferPersonalProvider)) {
    const userType =
      (await getUserDefaultModelProvider(orgId, userId, framework))?.type ??
      (await getUserAnyDefaultModelProvider(orgId, userId))?.type;
    if (userType) return;
  }

  // Framework-scoped default first; fall back to any org default so a
  // codex-only org still admits a claude-code compose. Mirrors the
  // cross-framework fallback in resolveProviderTypeForAdmission — see
  // Epic #11520 for the provider-framework-wins design intent.
  const defaultProviderType =
    (await getOrgDefaultModelProviderType(orgId, framework)) ??
    (await getOrgAnyDefaultModelProviderType(orgId));

  if (!defaultProviderType) {
    throw noModelProvider();
  }
}
