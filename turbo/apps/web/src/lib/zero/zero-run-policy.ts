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
  getModelProviderByIdForOrg,
} from "./model-provider/model-provider-service";
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
 *   explicit override → explicit modelProviderId → org default for framework.
 * Returns null when nothing is configured (admission decides whether that
 * is fatal).
 */
export async function resolveProviderTypeForAdmission(params: {
  orgId: string;
  modelProvider?: string | null;
  modelProviderId?: string | null;
  composeFramework: string;
}): Promise<ModelProviderType | null> {
  if (params.modelProvider && params.modelProvider in MODEL_PROVIDER_TYPES) {
    return params.modelProvider as ModelProviderType;
  }
  if (params.modelProviderId) {
    const row = await getModelProviderByIdForOrg(
      params.orgId,
      params.modelProviderId,
    );
    return row?.type ?? null;
  }
  const def = await getOrgDefaultModelProvider(
    params.orgId,
    params.composeFramework,
  );
  return def?.type ?? null;
}

/**
 * LLM-run credit admission. Resolves vm0 vs. BYOK from `modelProvider`
 * (or the org default when nullish) and delegates to `checkOrgCredits`
 * for the vm0 case. Returns silently for BYOK — the user pays the
 * provider, so no vm0 balance is touched.
 *
 * Accepts an optional `db` so callers inside a transaction (e.g.
 * `drainOrgQueue` under `pg_advisory_xact_lock`) keep the read within
 * the same boundary. Non-LLM callers use `checkOrgCredits` directly.
 */
export async function checkOrgCreditsForRun(
  orgId: string,
  userId: string,
  modelProvider: string | null | undefined,
  db: Database = globalThis.services.db,
): Promise<void> {
  // Fast exit for explicit BYOK — no DB touch.
  if (modelProvider && modelProvider !== "vm0") {
    return;
  }

  let isVm0 = modelProvider === "vm0";
  if (!isVm0) {
    // vm0 is the only credit-triggering provider, and it lives under
    // claude-code, so the "is the org's default vm0?" check is intrinsically
    // claude-code-scoped regardless of the run's framework.
    const defaultProviderType = await getOrgDefaultModelProviderType(
      orgId,
      "claude-code",
      db,
    );
    isVm0 = defaultProviderType === "vm0";
  }

  if (!isVm0) return;

  await checkOrgCredits(orgId, userId, db);
}

/**
 * Pre-flight check: ensure the org has a model provider configured.
 * Skips when compose has explicit env vars, an explicit modelProvider param
 * is provided, or the framework doesn't use model providers.
 */
export async function checkModelProviderConfigured(
  orgId: string,
  modelProvider: string | null | undefined,
  composeContent: AgentComposeYaml,
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

  const defaultProviderType = await getOrgDefaultModelProviderType(
    orgId,
    framework,
  );

  if (!defaultProviderType) {
    throw noModelProvider();
  }
}
