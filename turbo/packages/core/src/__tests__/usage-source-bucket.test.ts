import { describe, expect, it } from "vitest";

import { triggerSourceToBucket } from "../usage-source-bucket";

describe("triggerSourceToBucket", () => {
  it.each(["workflow-schedule", "workflow-event"] as const)(
    "maps %s to the automation display bucket",
    (source) => {
      expect(triggerSourceToBucket(source)).toBe("automation");
    },
  );
});
