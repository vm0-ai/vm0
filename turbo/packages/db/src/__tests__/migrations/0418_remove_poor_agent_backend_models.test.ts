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
  new URL(
    "../../migrations/0418_remove_poor_agent_backend_models.sql",
    import.meta.url,
  ),
  "utf8",
);

async function runMigration0418(): Promise<void> {
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
      prompt: "historical poor model run",
    })
    .returning({ id: agentRuns.id });

  await db.insert(zeroRuns).values({
    id: run!.id,
    triggerSource: "chat",
    selectedModel: "MiniMax-M2.7",
  });

  return run!.id;
}

describe("migration 0418 remove poor agent backend models", () => {
  it("updates active selections while leaving historical zero runs untouched", async () => {
    const userId = uniqueId("user");
    const haikuOrgId = uniqueId("org-haiku");
    const deepseekConflictOrgId = uniqueId("org-deepseek-conflict");
    const minimaxVm0OrgId = uniqueId("org-minimax-vm0");
    const minimaxOpenRouterOrgId = uniqueId("org-minimax-openrouter");
    const existingReplacementOrgId = uniqueId("org-existing-replacement");
    const duplicateReplacementOrgId = uniqueId("org-duplicate-replacement");
    const canonicalOpenRouterMiniMaxOrgId = uniqueId(
      "org-openrouter-minimax-canonical",
    );
    const canonicalOpenRouterDeepSeekOrgId = uniqueId(
      "org-openrouter-deepseek-canonical",
    );
    const canonicalVercelHaikuOrgId = uniqueId("org-vercel-haiku-canonical");
    const aliasPlainHaikuOrgId = uniqueId("org-haiku-plain-alias");
    const aliasAnthropicHaikuOrgId = uniqueId("org-anthropic-haiku-alias");
    const aliasDeepSeekOrgId = uniqueId("org-deepseek-alias");
    const aliasMiniMaxOrgId = uniqueId("org-minimax-alias");
    const activeOrgId = uniqueId("org-active");

    const [minimaxOpenRouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: minimaxOpenRouterOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "minimax/minimax-m2.7",
      })
      .returning({ id: modelProviders.id });

    const [duplicateOpenRouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: duplicateReplacementOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "anthropic/claude-haiku-4.5",
      })
      .returning({ id: modelProviders.id });

    const [existingReplacementOpenRouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: existingReplacementOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "minimax/minimax-m2.7",
      })
      .returning({ id: modelProviders.id });

    await db.insert(modelProviders).values([
      {
        orgId: activeOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "vercel-ai-gateway",
        authMethod: "api-key",
        selectedModel: "anthropic/claude-haiku-4.5",
      },
      {
        orgId: activeOrgId,
        userId: userId,
        type: "deepseek-api-key",
        authMethod: "api-key",
        selectedModel: "deepseek-v4-flash",
      },
      {
        orgId: canonicalOpenRouterMiniMaxOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "MiniMax-M2.7",
      },
      {
        orgId: canonicalOpenRouterDeepSeekOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "deepseek-v4-flash",
      },
      {
        orgId: canonicalVercelHaikuOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "vercel-ai-gateway",
        authMethod: "api-key",
        selectedModel: "claude-haiku-4-5",
      },
      {
        orgId: aliasPlainHaikuOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "claude-haiku-4.5",
      },
      {
        orgId: aliasAnthropicHaikuOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "anthropic-api-key",
        authMethod: "api-key",
        selectedModel: "anthropic/claude-haiku-4.5",
      },
      {
        orgId: aliasDeepSeekOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "deepseek-api-key",
        authMethod: "api-key",
        selectedModel: "deepseek/deepseek-v4-flash",
      },
      {
        orgId: aliasMiniMaxOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "minimax-api-key",
        authMethod: "api-key",
        selectedModel: "minimax/minimax-m2.7",
      },
    ]);

    await db.insert(orgModelPolicies).values([
      {
        orgId: haikuOrgId,
        model: "claude-haiku-4-5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: deepseekConflictOrgId,
        model: "deepseek-v4-flash",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: deepseekConflictOrgId,
        model: "deepseek-v4-pro",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: minimaxVm0OrgId,
        model: "MiniMax-M2.7",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: minimaxOpenRouterOrgId,
        model: "MiniMax-M2.7",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: minimaxOpenRouterProvider!.id,
      },
      {
        orgId: existingReplacementOrgId,
        model: "claude-sonnet-4-6",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingReplacementOrgId,
        model: "MiniMax-M2.7",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: existingReplacementOpenRouterProvider!.id,
      },
      {
        orgId: duplicateReplacementOrgId,
        model: "claude-haiku-4-5",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: duplicateReplacementOrgId,
        model: "MiniMax-M2.7",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: duplicateOpenRouterProvider!.id,
      },
    ]);

    const composeId = await seedCompose({ orgId: activeOrgId, userId });
    await db.insert(zeroAgents).values({
      id: composeId,
      orgId: activeOrgId,
      owner: userId,
      name: uniqueId("agent"),
      selectedModel: "MiniMax-M2.7",
    });
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId,
        agentComposeId: composeId,
        selectedModel: "deepseek/deepseek-v4-flash",
      })
      .returning({ id: chatThreads.id });
    await db.execute(sql`
      INSERT INTO org_members_metadata (org_id, user_id, selected_model)
      VALUES (${activeOrgId}, ${userId}, 'claude-haiku-4-5')
    `);
    const historicalRunId = await seedHistoricalZeroRun({
      orgId: activeOrgId,
      userId,
      composeId,
    });
    const aliasComposeId = await seedCompose({
      orgId: activeOrgId,
      userId,
    });
    await db.insert(zeroAgents).values({
      id: aliasComposeId,
      orgId: activeOrgId,
      owner: userId,
      name: uniqueId("agent-alias"),
      selectedModel: "minimax/minimax-m2.7",
    });
    const aliasPreferenceUserId = uniqueId("user-alias-preference");
    await db.execute(sql`
      INSERT INTO org_members_metadata (org_id, user_id, selected_model)
      VALUES (${activeOrgId}, ${aliasPreferenceUserId}, 'anthropic/claude-haiku-4.5')
    `);
    const plainAliasComposeId = await seedCompose({
      orgId: activeOrgId,
      userId,
    });
    await db.insert(zeroAgents).values({
      id: plainAliasComposeId,
      orgId: activeOrgId,
      owner: userId,
      name: uniqueId("agent-plain-alias"),
      selectedModel: "claude-haiku-4.5",
    });
    const [plainAliasThread] = await db
      .insert(chatThreads)
      .values({
        userId,
        agentComposeId: plainAliasComposeId,
        selectedModel: "claude-haiku-4.5",
      })
      .returning({ id: chatThreads.id });
    const plainAliasPreferenceUserId = uniqueId("user-plain-alias-preference");
    await db.execute(sql`
      INSERT INTO org_members_metadata (org_id, user_id, selected_model)
      VALUES (${activeOrgId}, ${plainAliasPreferenceUserId}, 'claude-haiku-4.5')
    `);

    await runMigration0418();
    await runMigration0418();

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
          haikuOrgId,
          deepseekConflictOrgId,
          minimaxVm0OrgId,
          minimaxOpenRouterOrgId,
          existingReplacementOrgId,
          duplicateReplacementOrgId,
        ]),
      )
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));

    expect(policies).toStrictEqual(
      sortPolicyRows([
        {
          orgId: haikuOrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
        {
          orgId: deepseekConflictOrgId,
          model: "deepseek-v4-pro",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
        {
          orgId: minimaxVm0OrgId,
          model: "MiniMax-M3",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        },
        {
          orgId: minimaxOpenRouterOrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: minimaxOpenRouterProvider!.id,
        },
        {
          orgId: existingReplacementOrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: existingReplacementOpenRouterProvider!.id,
        },
        {
          orgId: duplicateReplacementOrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: duplicateOpenRouterProvider!.id,
        },
      ]),
    );

    const providerSelections = await db
      .select({
        orgId: modelProviders.orgId,
        type: modelProviders.type,
        selectedModel: modelProviders.selectedModel,
      })
      .from(modelProviders)
      .where(
        inArray(modelProviders.orgId, [
          minimaxOpenRouterOrgId,
          duplicateReplacementOrgId,
          canonicalOpenRouterMiniMaxOrgId,
          canonicalOpenRouterDeepSeekOrgId,
          canonicalVercelHaikuOrgId,
          aliasPlainHaikuOrgId,
          aliasAnthropicHaikuOrgId,
          aliasDeepSeekOrgId,
          aliasMiniMaxOrgId,
          activeOrgId,
        ]),
      )
      .orderBy(asc(modelProviders.orgId), asc(modelProviders.type));

    expect(providerSelections).toEqual(
      expect.arrayContaining([
        {
          orgId: minimaxOpenRouterOrgId,
          type: "openrouter-api-key",
          selectedModel: "anthropic/claude-sonnet-4.6",
        },
        {
          orgId: duplicateReplacementOrgId,
          type: "openrouter-api-key",
          selectedModel: "anthropic/claude-sonnet-4.6",
        },
        {
          orgId: activeOrgId,
          type: "vercel-ai-gateway",
          selectedModel: "anthropic/claude-sonnet-4.6",
        },
        {
          orgId: activeOrgId,
          type: "deepseek-api-key",
          selectedModel: "deepseek-v4-pro",
        },
        {
          orgId: canonicalOpenRouterMiniMaxOrgId,
          type: "openrouter-api-key",
          selectedModel: "anthropic/claude-sonnet-4.6",
        },
        {
          orgId: canonicalOpenRouterDeepSeekOrgId,
          type: "openrouter-api-key",
          selectedModel: "deepseek/deepseek-v4-pro",
        },
        {
          orgId: canonicalVercelHaikuOrgId,
          type: "vercel-ai-gateway",
          selectedModel: "anthropic/claude-sonnet-4.6",
        },
        {
          orgId: aliasPlainHaikuOrgId,
          type: "openrouter-api-key",
          selectedModel: "anthropic/claude-sonnet-4.6",
        },
        {
          orgId: aliasAnthropicHaikuOrgId,
          type: "anthropic-api-key",
          selectedModel: "claude-sonnet-4-6",
        },
        {
          orgId: aliasDeepSeekOrgId,
          type: "deepseek-api-key",
          selectedModel: "deepseek-v4-pro",
        },
        {
          orgId: aliasMiniMaxOrgId,
          type: "minimax-api-key",
          selectedModel: "MiniMax-M3",
        },
      ]),
    );

    const [agent] = await db
      .select({ selectedModel: zeroAgents.selectedModel })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    const [aliasAgent] = await db
      .select({ selectedModel: zeroAgents.selectedModel })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, aliasComposeId));
    const [plainAliasAgent] = await db
      .select({ selectedModel: zeroAgents.selectedModel })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, plainAliasComposeId));
    const [updatedThread] = await db
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, thread!.id));
    const [updatedPlainAliasThread] = await db
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, plainAliasThread!.id));
    const [memberMetadata] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, activeOrgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    const [aliasMemberMetadata] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, activeOrgId),
          eq(orgMembersMetadata.userId, aliasPreferenceUserId),
        ),
      );
    const [plainAliasMemberMetadata] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, activeOrgId),
          eq(orgMembersMetadata.userId, plainAliasPreferenceUserId),
        ),
      );
    const [historicalRun] = await db
      .select({ selectedModel: zeroRuns.selectedModel })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, historicalRunId));

    expect(agent?.selectedModel).toBe("MiniMax-M3");
    expect(aliasAgent?.selectedModel).toBe("MiniMax-M3");
    expect(plainAliasAgent?.selectedModel).toBe("claude-sonnet-4-6");
    expect(updatedThread?.selectedModel).toBe("deepseek-v4-pro");
    expect(updatedPlainAliasThread?.selectedModel).toBe("claude-sonnet-4-6");
    expect(memberMetadata?.selectedModel).toBe("claude-sonnet-4-6");
    expect(aliasMemberMetadata?.selectedModel).toBe("claude-sonnet-4-6");
    expect(plainAliasMemberMetadata?.selectedModel).toBe("claude-sonnet-4-6");
    expect(historicalRun?.selectedModel).toBe("MiniMax-M2.7");
  });
});
