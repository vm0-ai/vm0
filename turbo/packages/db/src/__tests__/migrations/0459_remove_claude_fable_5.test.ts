import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { db, uniqueId } from "../test-db";

const ORG_SENTINEL_USER_ID = "__org__";

interface PolicyRow {
  readonly orgId: string;
  readonly model: string;
  readonly isDefault: boolean;
  readonly defaultProviderType: string;
  readonly credentialScope: string;
  readonly modelProviderId: string | null;
}

const migrationSql = readFileSync(
  new URL("../../migrations/0459_remove_claude_fable_5.sql", import.meta.url),
  "utf8",
);

async function runMigration0459(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

function sortPolicyRows(rows: readonly PolicyRow[]): readonly PolicyRow[] {
  return [...rows].sort((left, right) => {
    return `${left.orgId}\0${left.model}`.localeCompare(
      `${right.orgId}\0${right.model}`,
    );
  });
}

async function seedCompose(params: {
  readonly orgId: string;
  readonly userId: string;
}): Promise<string> {
  const [compose] = await db
    .insert(agentComposes)
    .values({
      orgId: params.orgId,
      userId: params.userId,
      name: uniqueId("compose"),
    })
    .returning({ id: agentComposes.id });

  return compose!.id;
}

async function seedHistoricalZeroRun(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}): Promise<string> {
  const [session] = await db
    .insert(agentSessions)
    .values({
      orgId: params.orgId,
      userId: params.userId,
      agentComposeId: params.composeId,
    })
    .returning({ id: agentSessions.id });

  const [run] = await db
    .insert(agentRuns)
    .values({
      orgId: params.orgId,
      userId: params.userId,
      sessionId: session!.id,
      status: "completed",
      prompt: "historical fable run",
    })
    .returning({ id: agentRuns.id });

  await db.insert(zeroRuns).values({
    id: run!.id,
    triggerSource: "chat",
    selectedModel: "claude-fable-5",
  });

  return run!.id;
}

describe("migration 0459 remove Claude Fable 5", () => {
  it("preserves historical usage pricing rows", async () => {
    const category = uniqueId("tokens-historical");
    await db.insert(usagePricing).values({
      kind: "model",
      provider: "claude-fable-5",
      category,
      unitPrice: 10,
      unitSize: 1_000_000,
    });

    await runMigration0459();

    const [row] = await db
      .select({
        provider: usagePricing.provider,
        category: usagePricing.category,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, "claude-fable-5"),
          eq(usagePricing.category, category),
        ),
      );

    expect(row).toStrictEqual({
      provider: "claude-fable-5",
      category,
    });
  });

  it("migrates active selections to Opus 4.8 while leaving historical zero runs untouched", async () => {
    const userId = uniqueId("user");
    const fableOnlyOrgId = uniqueId("org-fable-only");
    const existingOpusOrgId = uniqueId("org-existing-opus");
    const nonDefaultFableOrgId = uniqueId("org-non-default-fable");
    const providerOrgId = uniqueId("org-provider-selections");
    const activeOrgId = uniqueId("org-active-selections");

    const [openRouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: existingOpusOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "anthropic/claude-fable-5",
      })
      .returning({ id: modelProviders.id });

    await db.insert(orgModelPolicies).values([
      {
        orgId: fableOnlyOrgId,
        model: "claude-fable-5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingOpusOrgId,
        model: "claude-fable-5",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openRouterProvider!.id,
      },
      {
        orgId: existingOpusOrgId,
        model: "claude-opus-4-8",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: nonDefaultFableOrgId,
        model: "claude-fable-5",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: nonDefaultFableOrgId,
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
    ]);

    await db.insert(modelProviders).values([
      {
        orgId: providerOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "anthropic/claude-fable-5",
      },
      {
        orgId: providerOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "vercel-ai-gateway",
        authMethod: "api-key",
        selectedModel: "claude-fable-5",
      },
      {
        orgId: providerOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "anthropic-api-key",
        authMethod: "api-key",
        selectedModel: "anthropic/claude-fable-5",
      },
      {
        orgId: providerOrgId,
        userId: userId,
        type: "claude-code-oauth-token",
        authMethod: "oauth",
        selectedModel: "fable",
      },
    ]);

    const composeId = await seedCompose({ orgId: activeOrgId, userId });
    await db.insert(zeroAgents).values({
      id: composeId,
      orgId: activeOrgId,
      owner: userId,
      name: uniqueId("agent"),
      selectedModel: "claude-fable-5",
    });
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId,
        agentComposeId: composeId,
        selectedModel: "anthropic/claude-fable-5",
      })
      .returning({ id: chatThreads.id });
    await db.insert(orgMembersMetadata).values({
      orgId: activeOrgId,
      userId,
      selectedModel: "fable",
    });
    const historicalRunId = await seedHistoricalZeroRun({
      orgId: activeOrgId,
      userId,
      composeId,
    });

    await runMigration0459();
    await runMigration0459();

    const policies = await db
      .select({
        orgId: orgModelPolicies.orgId,
        model: orgModelPolicies.model,
        isDefault: orgModelPolicies.isDefault,
        defaultProviderType: orgModelPolicies.defaultProviderType,
        credentialScope: orgModelPolicies.credentialScope,
        modelProviderId: orgModelPolicies.modelProviderId,
      })
      .from(orgModelPolicies)
      .where(
        inArray(orgModelPolicies.orgId, [
          fableOnlyOrgId,
          existingOpusOrgId,
          nonDefaultFableOrgId,
        ]),
      )
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));

    expect(policies).toStrictEqual(
      sortPolicyRows([
        {
          orgId: fableOnlyOrgId,
          model: "claude-opus-4-8",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
        {
          orgId: existingOpusOrgId,
          model: "claude-opus-4-8",
          isDefault: true,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: openRouterProvider!.id,
        },
        {
          orgId: nonDefaultFableOrgId,
          model: "claude-opus-4-8",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]),
    );

    const providerSelections = await db
      .select({
        type: modelProviders.type,
        selectedModel: modelProviders.selectedModel,
      })
      .from(modelProviders)
      .where(eq(modelProviders.orgId, providerOrgId))
      .orderBy(asc(modelProviders.type), asc(modelProviders.userId));

    expect(providerSelections).toEqual(
      expect.arrayContaining([
        {
          type: "openrouter-api-key",
          selectedModel: "anthropic/claude-opus-4.8",
        },
        {
          type: "vercel-ai-gateway",
          selectedModel: "anthropic/claude-opus-4.8",
        },
        {
          type: "anthropic-api-key",
          selectedModel: "claude-opus-4-8",
        },
        {
          type: "claude-code-oauth-token",
          selectedModel: "claude-opus-4-8",
        },
      ]),
    );

    const [agent] = await db
      .select({ selectedModel: zeroAgents.selectedModel })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    const [updatedThread] = await db
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, thread!.id));
    const [memberMetadata] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, activeOrgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    const [historicalRun] = await db
      .select({ selectedModel: zeroRuns.selectedModel })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, historicalRunId));

    expect(agent?.selectedModel).toBe("claude-opus-4-8");
    expect(updatedThread?.selectedModel).toBe("claude-opus-4-8");
    expect(memberMetadata?.selectedModel).toBe("claude-opus-4-8");
    expect(historicalRun?.selectedModel).toBe("claude-fable-5");
  });
});
