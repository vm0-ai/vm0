import { describe, it, expect } from "vitest";
import {
  buildScheduleGuidance,
  DISALLOWED_CRON_TOOLS,
} from "../../../integration-context";

describe("schedule guidance for Slack runs", () => {
  describe("DISALLOWED_CRON_TOOLS", () => {
    it("contains all three cron tools", () => {
      expect(DISALLOWED_CRON_TOOLS).toEqual([
        "CronCreate",
        "CronList",
        "CronDelete",
      ]);
    });
  });

  describe("buildScheduleGuidance", () => {
    it("returns prompt mentioning vm0 schedule CLI", () => {
      const guidance = buildScheduleGuidance();

      expect(guidance).toContain("vm0 schedule");
    });

    it("warns against using cron tools", () => {
      const guidance = buildScheduleGuidance();

      expect(guidance).toContain("CronCreate");
      expect(guidance).toContain("CronList");
      expect(guidance).toContain("CronDelete");
      expect(guidance).toContain("not available");
    });

    it("includes setup, list, and delete commands", () => {
      const guidance = buildScheduleGuidance();

      expect(guidance).toContain("vm0 schedule setup");
      expect(guidance).toContain("vm0 schedule list");
      expect(guidance).toContain("vm0 schedule delete");
    });

    it("references VM0_AGENT_NAME for agent identification", () => {
      const guidance = buildScheduleGuidance();

      expect(guidance).toContain("$VM0_AGENT_NAME");
    });

    it("starts with a markdown heading", () => {
      const guidance = buildScheduleGuidance();

      expect(guidance).toMatch(/^# Scheduling Tasks/);
    });
  });
});
