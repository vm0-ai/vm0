import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
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
    "../../migrations/0493_add_mimo_hy3_model_support.sql",
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

async function runMigration0493(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

describe("migration 0493 add MiMo and Hy3 model support", () => {
  it("backfills production pricing and non-default VM0 model policies", async () => {
    const vm0OrgId = uniqueId("org-mimo-hy3-vm0");
    const existingMimoOrgId = uniqueId("org-mimo-existing");
    const byokOnlyOrgId = uniqueId("org-byok-only");
    const userId = uniqueId("user");

    await db.execute(sql`
      INSERT INTO "usage_pricing" ("kind", "provider", "category", "unit_price", "unit_size")
      VALUES
        ('model', 'mimo-v2.5', 'tokens.cache_creation', 1, 1),
        ('model', 'mimo-v2.5', 'tokens.cache_read', 1, 1),
        ('model', 'mimo-v2.5', 'tokens.input', 1, 1),
        ('model', 'mimo-v2.5', 'tokens.output', 1, 1),
        ('model', 'hy3-preview', 'tokens.cache_creation', 1, 1),
        ('model', 'hy3-preview', 'tokens.cache_read', 1, 1),
        ('model', 'hy3-preview', 'tokens.input', 1, 1),
        ('model', 'hy3-preview', 'tokens.output', 1, 1)
      ON CONFLICT ("kind", "provider", "category") DO UPDATE
      SET "unit_price" = EXCLUDED."unit_price",
          "unit_size" = EXCLUDED."unit_size",
          "updated_at" = NOW()
    `);

    const [existingOpenRouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: existingMimoOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "xiaomi/mimo-v2.5",
      })
      .returning({ id: modelProviders.id });
    const [byokOpenRouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: byokOnlyOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "xiaomi/mimo-v2.5",
      })
      .returning({ id: modelProviders.id });

    await db.insert(orgModelPolicies).values([
      {
        orgId: vm0OrgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      {
        orgId: existingMimoOrgId,
        model: "gpt-5.5",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingMimoOrgId,
        model: "mimo-v2.5",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: existingOpenRouterProvider!.id,
        createdByUserId: "existing-user",
        updatedByUserId: "existing-user",
      },
      {
        orgId: byokOnlyOrgId,
        model: "glm-5.1",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: byokOpenRouterProvider!.id,
      },
    ]);

    await runMigration0493();
    await runMigration0493();

    const prices = await db
      .select({
        provider: usagePricing.provider,
        category: usagePricing.category,
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          inArray(usagePricing.provider, ["mimo-v2.5", "hy3-preview"]),
        ),
      )
      .orderBy(asc(usagePricing.provider), asc(usagePricing.category));
    expect(prices).toStrictEqual([
      {
        provider: "hy3-preview",
        category: "tokens.cache_creation",
        unitPrice: 0,
        unitSize: 1_000_000,
      },
      {
        provider: "hy3-preview",
        category: "tokens.cache_read",
        unitPrice: 21,
        unitSize: 1_000_000,
      },
      {
        provider: "hy3-preview",
        category: "tokens.input",
        unitPrice: 63,
        unitSize: 1_000_000,
      },
      {
        provider: "hy3-preview",
        category: "tokens.output",
        unitPrice: 210,
        unitSize: 1_000_000,
      },
      {
        provider: "mimo-v2.5",
        category: "tokens.cache_creation",
        unitPrice: 0,
        unitSize: 1_000_000,
      },
      {
        provider: "mimo-v2.5",
        category: "tokens.cache_read",
        unitPrice: 3,
        unitSize: 1_000_000,
      },
      {
        provider: "mimo-v2.5",
        category: "tokens.input",
        unitPrice: 140,
        unitSize: 1_000_000,
      },
      {
        provider: "mimo-v2.5",
        category: "tokens.output",
        unitPrice: 280,
        unitSize: 1_000_000,
      },
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
          vm0OrgId,
          existingMimoOrgId,
          byokOnlyOrgId,
        ]),
      )
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));
    expect(policies).toStrictEqual(
      sortPolicyRows([
        {
          orgId: vm0OrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: vm0OrgId,
          model: "hy3-preview",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: vm0OrgId,
          model: "mimo-v2.5",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: existingMimoOrgId,
          model: "gpt-5.5",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: existingMimoOrgId,
          model: "hy3-preview",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: existingMimoOrgId,
          model: "mimo-v2.5",
          isDefault: false,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: existingOpenRouterProvider!.id,
          createdByUserId: "existing-user",
          updatedByUserId: "existing-user",
        },
        {
          orgId: byokOnlyOrgId,
          model: "glm-5.1",
          isDefault: true,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: byokOpenRouterProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
      ]),
    );
  });
});
