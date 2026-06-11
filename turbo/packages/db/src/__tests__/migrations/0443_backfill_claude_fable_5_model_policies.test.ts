import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, inArray, sql } from "drizzle-orm";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { db, uniqueId } from "../test-db";

const ORG_SENTINEL_USER_ID = "__org__";

const migrationSql = readFileSync(
  new URL(
    "../../migrations/0443_backfill_claude_fable_5_model_policies.sql",
    import.meta.url,
  ),
  "utf8",
);

async function runMigration0443(): Promise<void> {
  await db.execute(sql.raw(migrationSql));
}

describe("migration 0443 backfill Claude Fable 5 model policies", () => {
  it("does not manage model usage pricing", () => {
    expect(migrationSql).not.toContain('"usage_pricing"');
  });

  it("backfills non-default org policies from the highest available Claude route", async () => {
    const opus48OrgId = uniqueId("org-opus-48");
    const opus47OrgId = uniqueId("org-opus-47");
    const sonnetOrgId = uniqueId("org-sonnet");
    const existingFableOrgId = uniqueId("org-existing-fable");
    const noClaudeOrgId = uniqueId("org-no-claude");
    const userId = uniqueId("user");

    const [anthropicProvider] = await db
      .insert(modelProviders)
      .values({
        orgId: opus48OrgId,
        userId: ORG_SENTINEL_USER_ID,
        type: "anthropic-api-key",
        authMethod: "api-key",
        selectedModel: "claude-opus-4-8",
      })
      .returning({ id: modelProviders.id });

    await db.insert(orgModelPolicies).values([
      {
        orgId: opus48OrgId,
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: anthropicProvider!.id,
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      {
        orgId: opus48OrgId,
        model: "claude-opus-4-7",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: opus47OrgId,
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      {
        orgId: sonnetOrgId,
        model: "claude-sonnet-4-6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingFableOrgId,
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingFableOrgId,
        model: "claude-fable-5",
        isDefault: false,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        createdByUserId: "existing-user",
        updatedByUserId: "existing-user",
      },
      {
        orgId: noClaudeOrgId,
        model: "gpt-5.5",
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
      },
    ]);

    await runMigration0443();
    await runMigration0443();

    const policyRows = await db
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
          opus48OrgId,
          opus47OrgId,
          sonnetOrgId,
          existingFableOrgId,
          noClaudeOrgId,
        ]),
      )
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));

    const fableRows = policyRows.filter((row) => {
      return row.model === "claude-fable-5";
    });
    expect(fableRows).toHaveLength(4);
    expect(fableRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orgId: opus48OrgId,
          isDefault: false,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: anthropicProvider!.id,
          createdByUserId: userId,
          updatedByUserId: userId,
        }),
        expect.objectContaining({
          orgId: opus47OrgId,
          isDefault: false,
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
          createdByUserId: userId,
          updatedByUserId: userId,
        }),
        expect.objectContaining({
          orgId: sonnetOrgId,
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          createdByUserId: null,
          updatedByUserId: null,
        }),
        expect.objectContaining({
          orgId: existingFableOrgId,
          isDefault: false,
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
          modelProviderId: null,
          createdByUserId: "existing-user",
          updatedByUserId: "existing-user",
        }),
      ]),
    );
    expect(
      policyRows.some((row) => {
        return row.orgId === noClaudeOrgId && row.model === "claude-fable-5";
      }),
    ).toBe(false);
    expect(
      policyRows.filter((row) => {
        return row.isDefault;
      }),
    ).toHaveLength(5);
  });
});
