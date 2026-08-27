import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { officialAutomationResultEmailClaims } from "../schema/official-automation-result-email-claim";

describe("Official Automation result email claim physical identity", () => {
  it("retains one source claim independently of Run, Automation, and outbox rows", () => {
    const config = getTableConfig(officialAutomationResultEmailClaims);

    expect(config.name).toBe("official_automation_result_email_claims");
    expect(
      config.columns
        .map((column) => {
          return column.name;
        })
        .sort(),
    ).toStrictEqual([
      "created_at",
      "email_outbox_id",
      "run_id",
      "workflow_automation_id",
    ]);
    expect(config.foreignKeys).toStrictEqual([]);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]?.getName()).toBe(
      "official_automation_result_email_claims_pkey",
    );
    expect(
      config.indexes.map((index) => {
        return index.config.name;
      }),
    ).toStrictEqual(["official_automation_result_email_claims_outbox_unique"]);
  });
});
