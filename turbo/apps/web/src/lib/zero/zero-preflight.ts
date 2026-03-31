import { eq, and } from "drizzle-orm";
import { modelProviders } from "../../db/schema/model-provider";
import { orgMetadata } from "../../db/schema/org-metadata";
import { orgMembersMetadata } from "../../db/schema/org-members-metadata";
import { ORG_SENTINEL_USER_ID } from "../org/org-sentinel";
import { insufficientCredits, noModelProvider } from "../errors";
import { MODEL_PROVIDER_ENV_VARS } from "../run/build-context";
import type { AgentComposeYaml } from "../../types/agent-compose";
import type { Database } from "../../types/global";

/**
 * Check if the org has sufficient credits for a VM0 provider run.
 *
 * Only blocks runs using the VM0 managed provider (where the platform
 * bears API costs). Runs using the org's own API key are not affected.
 *
 * Uses lazy resolution: the org default provider is only queried
 * when modelProvider is null AND credits are already depleted.
 */
export async function checkOrgCredits(
  orgId: string,
  userId: string,
  modelProvider: string | null | undefined,
  db: Database,
): Promise<void> {
  // Explicit non-VM0 provider — skip check entirely
  if (modelProvider && modelProvider !== "vm0") {
    return;
  }

  // Determine if this is a VM0 run
  let isVm0 = modelProvider === "vm0";

  if (!isVm0 && !modelProvider) {
    // Resolve org default provider to determine if this is a VM0 run
    const [defaultProvider] = await db
      .select({ type: modelProviders.type })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          eq(modelProviders.isDefault, true),
        ),
      )
      .limit(1);
    isVm0 = defaultProvider?.type === "vm0";
  }

  // Per-member credit cap check — only for VM0 runs
  if (isVm0) {
    const [memberRow] = await db
      .select({ creditEnabled: orgMembersMetadata.creditEnabled })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);

    if (memberRow?.creditEnabled === false) {
      throw insufficientCredits();
    }
  }

  // Read credits from org_metadata
  const [orgRow] = await db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);

  // No org row → treat as sufficient (new org, default 10000 credits)
  if (!orgRow) {
    return;
  }

  // Credits > 0 → sufficient for any provider
  if (orgRow.credits > 0) {
    return;
  }

  // Credits <= 0 and VM0 run — insufficient
  if (isVm0) {
    throw insufficientCredits();
  }

  // Effective provider is not VM0 — skip check
}

/**
 * Pre-INSERT check: ensure the org has a model provider configured.
 * Skips the check when:
 * - The compose has explicit model provider env vars (e.g. ANTHROPIC_API_KEY)
 * - An explicit modelProvider param is provided (validated later in build-context)
 * - The framework doesn't use model providers (non-claude-code)
 */
export async function checkModelProviderConfigured(
  orgId: string,
  modelProvider: string | null | undefined,
  composeContent: AgentComposeYaml,
  db: Database,
): Promise<void> {
  // Explicit modelProvider param provided — skip (will be validated in build-context)
  if (modelProvider) return;

  // Extract framework and environment from first agent
  const firstAgent = composeContent.agents
    ? Object.values(composeContent.agents)[0]
    : undefined;
  const framework = firstAgent?.framework || "claude-code";

  // Only claude-code framework needs provider resolution
  if (framework !== "claude-code") return;

  // If compose has explicit model provider env vars, skip check
  const hasExplicitConfig = MODEL_PROVIDER_ENV_VARS.some(
    (v) => firstAgent?.environment?.[v] !== undefined,
  );
  if (hasExplicitConfig) return;

  // Check if org has a default model provider
  const [defaultProvider] = await db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.isDefault, true),
      ),
    )
    .limit(1);

  if (!defaultProvider) {
    throw noModelProvider();
  }
}
