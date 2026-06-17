import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const ORG_SENTINEL_USER_ID = "__org__";

interface PolicyRow {
  readonly orgId: string;
  readonly model: string;
  readonly isDefault: boolean;
  readonly defaultProviderType: string;
  readonly credentialScope: string;
  readonly modelProviderId: string | null;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
}

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0465_add_glm_5_2_model_support.sql",
    import.meta.url,
  ),
  "utf8",
);

function sortPolicyRows(rows: readonly PolicyRow[]): readonly PolicyRow[] {
  return [...rows].sort((left, right) => {
    return `${left.orgId}\0${left.model}`.localeCompare(
      `${right.orgId}\0${right.model}`,
    );
  });
}

async function runMigration0465(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

describe("migration 0465 add GLM 5.2 model support", () => {
  it("does not manage model usage pricing", () => {
    expect(migrationSql).not.toContain('"usage_pricing"');
  });

  it("backfills GLM 5.2 availability without migrating existing selections", async () => {
    const vm0DefaultOrgId = uniqueId("org-glm-vm0-default");
    const zaiOrgId = uniqueId("org-glm-zai");
    const openRouterOrgId = uniqueId("org-glm-openrouter");
    const existing52OrgId = uniqueId("org-glm-existing-52");
    const noGlmOrgId = uniqueId("org-no-glm");
    const incompatibleOrgId = uniqueId("org-glm-incompatible");
    const missingProviderOrgId = uniqueId("org-glm-missing-provider");
    const userId = uniqueId("user");

    const [vm0Provider] = await db
      .insert(modelProviders)
      .values({
        orgId: vm0DefaultOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "vm0",
        authMethod: "api-key",
        selectedModel: "glm-5.1",
      })
      .returning({ id: modelProviders.id });
    const [zaiProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: zaiOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "zai-api-key",
        authMethod: "api-key",
        selectedModel: "glm-5.1",
      })
      .returning({ id: modelProviders.id });
    const [openRouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: openRouterOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "z-ai/glm-5.1",
      })
      .returning({ id: modelProviders.id });
    const [existing52Provider] = await db
      .insert(modelProviders)
      .values({
        orgId: existing52OrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "zai-api-key",
        authMethod: "api-key",
        selectedModel: "glm-5.2",
      })
      .returning({ id: modelProviders.id });
    const [incompatibleProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: incompatibleOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "anthropic-api-key",
        authMethod: "api-key",
        selectedModel: "glm-5.1",
      })
      .returning({ id: modelProviders.id });

    await db.insert(orgModelPolicies).values([
      {
        orgId: vm0DefaultOrgId,
        model: "glm-5.1",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      {
        orgId: zaiOrgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: zaiOrgId,
        model: "glm-5.1",
        isDefault: false,
        defaultProviderType: "zai-api-key",
        credentialScope: "org",
        modelProviderId: zaiProvider!.id,
      },
      {
        orgId: openRouterOrgId,
        model: "glm-5.1",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openRouterProvider!.id,
      },
      {
        orgId: existing52OrgId,
        model: "glm-5.1",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existing52OrgId,
        model: "glm-5.2",
        isDefault: false,
        defaultProviderType: "zai-api-key",
        credentialScope: "org",
        modelProviderId: existing52Provider!.id,
        createdByUserId: "existing-user",
        updatedByUserId: "existing-user",
      },
      {
        orgId: noGlmOrgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: incompatibleOrgId,
        model: "glm-5.1",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: incompatibleProvider!.id,
      },
      {
        orgId: missingProviderOrgId,
        model: "glm-5.1",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    const [chatCompose] = await db
      .insert(agentComposes)
      .values({
        orgId: vm0DefaultOrgId,
        userId,
        name: uniqueId("chat-agent"),
      })
      .returning({ id: agentComposes.id });
    const [zeroCompose] = await db
      .insert(agentComposes)
      .values({
        orgId: vm0DefaultOrgId,
        userId,
        name: uniqueId("zero-agent"),
      })
      .returning({ id: agentComposes.id });
    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId,
        agentComposeId: chatCompose!.id,
        selectedModel: "glm-5.1",
      })
      .returning({ id: chatThreads.id });
    await db.insert(zeroAgents).values({
      id: zeroCompose!.id,
      orgId: vm0DefaultOrgId,
      owner: userId,
      name: uniqueId("zero"),
      selectedModel: "glm-5.1",
    });
    await db.insert(orgMembersMetadata).values({
      orgId: vm0DefaultOrgId,
      userId,
      selectedModel: "glm-5.1",
    });

    await runMigration0465();
    await runMigration0465();

    const policies = await db
      .select({
        orgId: orgModelPolicies.orgId,
        model: orgModelPolicies.model,
        isDefault: orgModelPolicies.isDefault,
        defaultProviderType: orgModelPolicies.defaultProviderType,
        credentialScope: orgModelPolicies.credentialScope,
        modelProviderId: orgModelPolicies.modelProviderId,
        createdByUserId: orgModelPolicies.createdByUserId,
        updatedByUserId: orgModelPolicies.updatedByUserId,
      })
      .from(orgModelPolicies)
      .where(
        and(
          inArray(orgModelPolicies.orgId, [
            vm0DefaultOrgId,
            zaiOrgId,
            openRouterOrgId,
            existing52OrgId,
            noGlmOrgId,
            incompatibleOrgId,
            missingProviderOrgId,
          ]),
          inArray(orgModelPolicies.model, [
            "claude-sonnet-4-6",
            "glm-5.1",
            "glm-5.2",
          ]),
        ),
      )
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));
    expect(policies).toStrictEqual(
      sortPolicyRows([
        {
          orgId: vm0DefaultOrgId,
          model: "glm-5.1",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: vm0DefaultOrgId,
          model: "glm-5.2",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: zaiOrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: zaiOrgId,
          model: "glm-5.1",
          isDefault: false,
          defaultProviderType: "zai-api-key",
          credentialScope: "org",
          modelProviderId: zaiProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: zaiOrgId,
          model: "glm-5.2",
          isDefault: false,
          defaultProviderType: "zai-api-key",
          credentialScope: "org",
          modelProviderId: zaiProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: openRouterOrgId,
          model: "glm-5.1",
          isDefault: false,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: openRouterProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: openRouterOrgId,
          model: "glm-5.2",
          isDefault: false,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: openRouterProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: existing52OrgId,
          model: "glm-5.1",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: existing52OrgId,
          model: "glm-5.2",
          isDefault: false,
          defaultProviderType: "zai-api-key",
          credentialScope: "org",
          modelProviderId: existing52Provider!.id,
          createdByUserId: "existing-user",
          updatedByUserId: "existing-user",
        },
        {
          orgId: noGlmOrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: incompatibleOrgId,
          model: "glm-5.1",
          isDefault: false,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: incompatibleProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: missingProviderOrgId,
          model: "glm-5.1",
          isDefault: false,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
      ]),
    );

    const providerSelections = await db
      .select({
        id: modelProviders.id,
        selectedModel: modelProviders.selectedModel,
      })
      .from(modelProviders)
      .where(
        inArray(modelProviders.id, [
          vm0Provider!.id,
          zaiProvider!.id,
          openRouterProvider!.id,
        ]),
      );
    const providerSelectionsById = new Map(
      providerSelections.map((provider) => {
        return [provider.id, provider.selectedModel] as const;
      }),
    );
    expect(providerSelectionsById.get(vm0Provider!.id)).toBe("glm-5.1");
    expect(providerSelectionsById.get(zaiProvider!.id)).toBe("glm-5.1");
    expect(providerSelectionsById.get(openRouterProvider!.id)).toBe(
      "z-ai/glm-5.1",
    );

    const [threadRow] = await db
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, thread!.id));
    expect(threadRow?.selectedModel).toBe("glm-5.1");

    const [zeroAgentRow] = await db
      .select({ selectedModel: zeroAgents.selectedModel })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, zeroCompose!.id));
    expect(zeroAgentRow?.selectedModel).toBe("glm-5.1");

    const [memberMetadataRow] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, vm0DefaultOrgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    expect(memberMetadataRow?.selectedModel).toBe("glm-5.1");
  });
});
