import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { db, uniqueId } from "../test-db";

const ORG_SENTINEL_USER_ID = "__org__";

const migrationSql = readFileSync(
  new URL("../../migrations/0460_add_kimi_k2_7_code.sql", import.meta.url),
  "utf8",
);

async function runMigration0460(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

describe("migration 0460 add Kimi K2.7 Code", () => {
  it("adds K2.7 pricing, upgrades K2.6 policies, and removes old Kimi policies", async () => {
    const defaultK26OrgId = uniqueId("org-k26-default");
    const openrouterK26OrgId = uniqueId("org-k26-openrouter");
    const k25OnlyOrgId = uniqueId("org-k25-only");
    const existingK27OrgId = uniqueId("org-existing-k27");
    const userId = uniqueId("user");

    await db.execute(sql`
      INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
      VALUES
        ('model', 'kimi-k2.7-code', 'tokens.cache_creation', 1, 1),
        ('model', 'kimi-k2.7-code', 'tokens.cache_read', 1, 1),
        ('model', 'kimi-k2.7-code', 'tokens.input', 1, 1),
        ('model', 'kimi-k2.7-code', 'tokens.output', 1, 1)
      ON CONFLICT ("kind", "provider", "category") DO UPDATE
      SET "unit_price" = EXCLUDED."unit_price",
          "unit_size" = EXCLUDED."unit_size",
          "updated_at" = NOW()
    `);

    const [moonshotProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: defaultK26OrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "moonshot-api-key",
        authMethod: "api-key",
        selectedModel: "kimi-k2.5",
      })
      .returning({ id: modelProviders.id });
    const [openrouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: openrouterK26OrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "kimi-k2.6",
      })
      .returning({ id: modelProviders.id });
    const [vm0Provider] = await db
      .insert(modelProviders)
      .values({
        orgId: existingK27OrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "vm0",
        authMethod: "api-key",
        selectedModel: "moonshotai/kimi-k2.6",
      })
      .returning({ id: modelProviders.id });

    await db.insert(orgModelPolicies).values([
      {
        orgId: defaultK26OrgId,
        model: "kimi-k2.6",
        isDefault: true,
        defaultProviderType: "moonshot-api-key",
        credentialScope: "org",
        modelProviderId: moonshotProvider!.id,
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      {
        orgId: defaultK26OrgId,
        model: "kimi-k2.5",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: openrouterK26OrgId,
        model: "kimi-k2.6",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openrouterProvider!.id,
      },
      {
        orgId: k25OnlyOrgId,
        model: "kimi-k2.5",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingK27OrgId,
        model: "kimi-k2.6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingK27OrgId,
        model: "kimi-k2.7-code",
        isDefault: false,
        defaultProviderType: "moonshot-api-key",
        credentialScope: "org",
        modelProviderId: vm0Provider!.id,
        createdByUserId: "existing-user",
        updatedByUserId: "existing-user",
      },
    ]);

    const [chatCompose] = await db
      .insert(agentComposes)
      .values({
        orgId: defaultK26OrgId,
        userId,
        name: uniqueId("chat-agent"),
      })
      .returning({ id: agentComposes.id });
    const [zeroCompose] = await db
      .insert(agentComposes)
      .values({
        orgId: defaultK26OrgId,
        userId,
        name: uniqueId("zero-agent"),
      })
      .returning({ id: agentComposes.id });

    const [thread] = await db
      .insert(chatThreads)
      .values({
        userId,
        agentComposeId: chatCompose!.id,
        selectedModel: "kimi-k2.5",
      })
      .returning({ id: chatThreads.id });
    await db.insert(zeroAgents).values({
      id: zeroCompose!.id,
      orgId: defaultK26OrgId,
      owner: userId,
      name: uniqueId("zero"),
      selectedModel: "kimi-k2.6",
    });
    await db.insert(orgMembersMetadata).values({
      orgId: defaultK26OrgId,
      userId,
      selectedModel: "moonshotai/kimi-k2.5",
    });

    await runMigration0460();
    await runMigration0460();

    const k27Prices = await db
      .select({
        category: usagePricing.category,
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, "kimi-k2.7-code"),
        ),
      )
      .orderBy(asc(usagePricing.category));
    expect(k27Prices).toStrictEqual([
      { category: "tokens.cache_creation", unitPrice: 1140, unitSize: 1000000 },
      { category: "tokens.cache_read", unitPrice: 192, unitSize: 1000000 },
      { category: "tokens.input", unitPrice: 1140, unitSize: 1000000 },
      { category: "tokens.output", unitPrice: 4800, unitSize: 1000000 },
    ]);

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
        inArray(orgModelPolicies.orgId, [
          defaultK26OrgId,
          openrouterK26OrgId,
          k25OnlyOrgId,
          existingK27OrgId,
        ]),
      )
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));
    expect(
      policies.some((policy) => {
        return policy.model === "kimi-k2.6" || policy.model === "kimi-k2.5";
      }),
    ).toBe(false);
    expect(policies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orgId: defaultK26OrgId,
          model: "kimi-k2.7-code",
          isDefault: true,
          defaultProviderType: "moonshot-api-key",
          credentialScope: "org",
          modelProviderId: moonshotProvider!.id,
          createdByUserId: userId,
          updatedByUserId: userId,
        }),
        expect.objectContaining({
          orgId: openrouterK26OrgId,
          model: "kimi-k2.7-code",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
        }),
        expect.objectContaining({
          orgId: existingK27OrgId,
          model: "kimi-k2.7-code",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: "existing-user",
        }),
      ]),
    );
    expect(
      policies.some((policy) => {
        return policy.orgId === k25OnlyOrgId;
      }),
    ).toBe(false);

    const providerSelections = await db
      .select({
        type: modelProviders.type,
        selectedModel: modelProviders.selectedModel,
      })
      .from(modelProviders)
      .where(
        inArray(modelProviders.id, [
          moonshotProvider!.id,
          openrouterProvider!.id,
          vm0Provider!.id,
        ]),
      )
      .orderBy(asc(modelProviders.type));
    expect(providerSelections).toStrictEqual([
      { type: "moonshot-api-key", selectedModel: "kimi-k2.7-code" },
      { type: "openrouter-api-key", selectedModel: null },
      { type: "vm0", selectedModel: "kimi-k2.7-code" },
    ]);

    const [threadRow] = await db
      .select({ selectedModel: chatThreads.selectedModel })
      .from(chatThreads)
      .where(eq(chatThreads.id, thread!.id));
    expect(threadRow?.selectedModel).toBe("kimi-k2.7-code");

    const [zeroAgentRow] = await db
      .select({ selectedModel: zeroAgents.selectedModel })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, zeroCompose!.id));
    expect(zeroAgentRow?.selectedModel).toBe("kimi-k2.7-code");

    const [memberMetadataRow] = await db
      .select({ selectedModel: orgMembersMetadata.selectedModel })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, defaultK26OrgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      );
    expect(memberMetadataRow?.selectedModel).toBe("kimi-k2.7-code");
  });
});
