import { describe, expect, it } from "vitest";

import { triggerSourceSchema } from "../logs";

describe("triggerSourceSchema", () => {
  it.each(["workflow-schedule", "workflow-event"])(
    "accepts the current Workflow Automation source %s",
    (source) => {
      expect(triggerSourceSchema.safeParse(source).success).toBe(true);
    },
  );

  it("rejects the removed legacy automation source", () => {
    expect(triggerSourceSchema.safeParse("automation").success).toBe(false);
  });
});
