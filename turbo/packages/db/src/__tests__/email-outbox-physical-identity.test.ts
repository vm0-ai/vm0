import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { emailOutbox } from "../schema/email-outbox";

describe("email outbox physical identity", () => {
  it("keeps the durable Automation result source pair and exact constraints", () => {
    const config = getTableConfig(emailOutbox);

    expect(config.name).toBe("email_outbox");
    expect(config.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "source_run_id" }),
        expect.objectContaining({ name: "source_workflow_automation_id" }),
      ]),
    );
    expect(config.foreignKeys).toStrictEqual([]);
    expect(
      config.indexes
        .flatMap((index) => {
          return index.config.name ? [index.config.name] : [];
        })
        .sort(),
    ).toStrictEqual([
      "email_outbox_created_at_idx",
      "email_outbox_drain_idx",
      "email_outbox_source_run_automation_unique",
    ]);
    expect(
      config.checks.map((check) => {
        return check.name;
      }),
    ).toStrictEqual(["email_outbox_source_identity_check"]);
  });
});
