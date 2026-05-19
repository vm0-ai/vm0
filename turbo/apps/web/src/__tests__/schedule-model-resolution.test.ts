import { describe, it, expect } from "vitest";
import { adaptScheduleTrigger } from "../lib/zero/schedule/adapt-schedule-trigger";

describe("Schedule model resolution", () => {
  describe("adaptScheduleTrigger model passthrough", () => {
    it("does not include schedule model overrides so runtime fallback kicks in", () => {
      const result = adaptScheduleTrigger({
        userId: "test-user",
        agentId: "test-agent",
        scheduleId: "test-schedule",
        prompt: "test",
        appendSystemPrompt: undefined,
        triggerType: "cron",
        cronExpression: "0 0 * * *",
        timezone: "UTC",
        apiStartTime: Date.now(),
      });

      expect(result.modelProviderId).toBeUndefined();
      expect(result.selectedModelOverride).toBeUndefined();
    });
  });
});
