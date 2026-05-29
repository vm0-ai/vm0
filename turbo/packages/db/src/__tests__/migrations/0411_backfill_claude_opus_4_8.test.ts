import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, inArray, sql } from "drizzle-orm";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
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
    "../../migrations/0411_backfill_claude_opus_4_8.sql",
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

async function runMigration0411(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

describe("migration 0411 backfill Claude Opus 4.8 policies", () => {
  it("only backfills org model policies", () => {
    expect(migrationSql).not.toContain('INSERT INTO "usage_pricing"');
    expect(migrationSql).not.toContain('INSERT INTO "vm0_api_keys"');
    expect(migrationSql).toContain('INSERT INTO "org_model_policies"');
  });

  it("handles selected, unselected, absent, built-in, BYOK, OAuth, and existing policy cases", async () => {
    const selected47OrgId = uniqueId("org-selected-47");
    const non47DefaultOrgId = uniqueId("org-non47-default");
    const no47OrgId = uniqueId("org-no47");
    const byokAnthropicOrgId = uniqueId("org-byok-anthropic");
    const byokOpenrouterOrgId = uniqueId("org-byok-openrouter");
    const existing48OrgId = uniqueId("org-existing-48");
    const userId = uniqueId("user");

    const [anthropicProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: byokAnthropicOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "anthropic-api-key",
        authMethod: "api-key",
        selectedModel: "claude-opus-4-7",
      })
      .returning({ id: modelProviders.id });
    const [openrouterProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: byokOpenrouterOrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "openrouter-api-key",
        authMethod: "api-key",
        selectedModel: "claude-opus-4-7",
      })
      .returning({ id: modelProviders.id });

    await db.insert(orgModelPolicies).values([
      {
        orgId: selected47OrgId,
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      {
        orgId: non47DefaultOrgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: non47DefaultOrgId,
        model: "claude-opus-4-7",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: no47OrgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: byokAnthropicOrgId,
        model: "claude-opus-4-7",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: anthropicProvider!.id,
      },
      {
        orgId: byokOpenrouterOrgId,
        model: "claude-opus-4-7",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openrouterProvider!.id,
      },
      {
        orgId: existing48OrgId,
        model: "claude-opus-4-7",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existing48OrgId,
        model: "claude-opus-4-8",
        isDefault: false,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        createdByUserId: "existing-user",
        updatedByUserId: "existing-user",
      },
    ]);

    await runMigration0411();
    await runMigration0411();

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
          selected47OrgId,
          non47DefaultOrgId,
          no47OrgId,
          byokAnthropicOrgId,
          byokOpenrouterOrgId,
          existing48OrgId,
        ]),
      )
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));

    expect(policies).toStrictEqual(
      sortPolicyRows([
        {
          orgId: selected47OrgId,
          model: "claude-opus-4-7",
          isDefault: true,
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: selected47OrgId,
          model: "claude-opus-4-8",
          isDefault: false,
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: non47DefaultOrgId,
          model: "claude-opus-4-7",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: non47DefaultOrgId,
          model: "claude-opus-4-8",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: non47DefaultOrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: no47OrgId,
          model: "claude-sonnet-4-6",
          isDefault: true,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: byokAnthropicOrgId,
          model: "claude-opus-4-7",
          isDefault: false,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: anthropicProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: byokAnthropicOrgId,
          model: "claude-opus-4-8",
          isDefault: false,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: anthropicProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: byokOpenrouterOrgId,
          model: "claude-opus-4-7",
          isDefault: false,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: openrouterProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: byokOpenrouterOrgId,
          model: "claude-opus-4-8",
          isDefault: false,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          modelProviderId: openrouterProvider!.id,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: existing48OrgId,
          model: "claude-opus-4-7",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: existing48OrgId,
          model: "claude-opus-4-8",
          isDefault: false,
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
          createdByUserId: "existing-user",
          updatedByUserId: "existing-user",
        },
      ]),
    );
  });
});
