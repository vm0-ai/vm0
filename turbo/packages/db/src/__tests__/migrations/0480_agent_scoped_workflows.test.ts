import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  new URL("../../migrations/0480_agent_scoped_workflows.sql", import.meta.url),
  "utf8",
);

describe("migration 0480 agent-scoped workflows", () => {
  it("drops the old org/name unique index before duplicating multi-bound workflows", () => {
    const dropOrgNameIndex = migrationSql.search(
      /DROP INDEX(?: IF EXISTS)? "idx_zero_workflows_org_name"/,
    );
    const duplicateMultiBoundWorkflows = migrationSql.indexOf(
      'INSERT INTO "zero_workflows"',
    );

    expect(dropOrgNameIndex).toBeGreaterThanOrEqual(0);
    expect(duplicateMultiBoundWorkflows).toBeGreaterThanOrEqual(0);
    expect(dropOrgNameIndex).toBeLessThan(duplicateMultiBoundWorkflows);
  });
});
