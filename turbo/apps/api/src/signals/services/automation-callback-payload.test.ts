import { describe, expect, it } from "vitest";

import {
  automationCronCallbackPayloadSchema,
  automationLoopCallbackPayloadSchema,
} from "./automation-callback-payload";

const AUTOMATION_ID = "automation-1";

describe.each([
  {
    name: "cron",
    schema: automationCronCallbackPayloadSchema,
    fields: { timezone: "UTC", cronExpression: "0 9 * * *" },
  },
  {
    name: "loop",
    schema: automationLoopCallbackPayloadSchema,
    fields: {},
  },
])("$name automation callback payload", ({ schema, fields }) => {
  it("normalizes a legacy-only identifier", () => {
    expect(schema.parse({ ...fields, triggerId: AUTOMATION_ID })).toMatchObject(
      {
        automationId: AUTOMATION_ID,
        triggerId: AUTOMATION_ID,
      },
    );
  });

  it("accepts a canonical-only identifier", () => {
    expect(
      schema.parse({ ...fields, automationId: AUTOMATION_ID }),
    ).toMatchObject({
      automationId: AUTOMATION_ID,
    });
  });

  it("accepts equal dual identifiers", () => {
    expect(
      schema.parse({
        ...fields,
        automationId: AUTOMATION_ID,
        triggerId: AUTOMATION_ID,
      }),
    ).toMatchObject({
      automationId: AUTOMATION_ID,
      triggerId: AUTOMATION_ID,
    });
  });

  it("rejects unequal dual identifiers", () => {
    expect(
      schema.safeParse({
        ...fields,
        automationId: AUTOMATION_ID,
        triggerId: "automation-2",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing identifier", () => {
    expect(schema.safeParse(fields).success).toBe(false);
  });
});
