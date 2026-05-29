import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { asc, inArray, sql } from "drizzle-orm";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { db, uniqueId } from "../test-db";

interface PolicyRow {
  readonly orgId: string;
  readonly model: string;
  readonly isDefault: boolean;
  readonly defaultProviderType: string;
  readonly credentialScope: string;
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

  it("copies Opus 4.7 policy routes without changing org defaults or existing Opus 4.8 rows", async () => {
    const orgId = uniqueId("org");
    const existingOrgId = uniqueId("org");
    const userId = uniqueId("user");

    await db.insert(orgModelPolicies).values([
      {
        orgId,
        model: "claude-opus-4-7",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        createdByUserId: userId,
        updatedByUserId: userId,
      },
      {
        orgId: existingOrgId,
        model: "claude-opus-4-7",
        isDefault: false,
        defaultProviderType: "vm0",
        credentialScope: "org",
      },
      {
        orgId: existingOrgId,
        model: "claude-opus-4-8",
        isDefault: false,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
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
        createdByUserId: orgModelPolicies.createdByUserId,
        updatedByUserId: orgModelPolicies.updatedByUserId,
      })
      .from(orgModelPolicies)
      .where(inArray(orgModelPolicies.orgId, [orgId, existingOrgId]))
      .orderBy(asc(orgModelPolicies.orgId), asc(orgModelPolicies.model));

    expect(policies).toStrictEqual(
      sortPolicyRows([
        {
          orgId,
          model: "claude-opus-4-7",
          isDefault: true,
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId,
          model: "claude-opus-4-8",
          isDefault: false,
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
          createdByUserId: userId,
          updatedByUserId: userId,
        },
        {
          orgId: existingOrgId,
          model: "claude-opus-4-7",
          isDefault: false,
          defaultProviderType: "vm0",
          credentialScope: "org",
          createdByUserId: null,
          updatedByUserId: null,
        },
        {
          orgId: existingOrgId,
          model: "claude-opus-4-8",
          isDefault: false,
          defaultProviderType: "openrouter-api-key",
          credentialScope: "org",
          createdByUserId: "existing-user",
          updatedByUserId: "existing-user",
        },
      ]),
    );
  });
});
