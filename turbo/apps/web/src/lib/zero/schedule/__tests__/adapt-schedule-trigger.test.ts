import { describe, it, expect } from "vitest";
import { adaptScheduleTrigger } from "../adapt-schedule-trigger";

describe("adaptScheduleTrigger", () => {
  const base = {
    userId: "user-1",
    agentId: "agent-1",
    scheduleId: "sched-1",
    prompt: "hello",
    appendSystemPrompt: "sys",
    timezone: "UTC",
    cronExpression: undefined as string | undefined,
  };

  it("maps loop trigger to loop callback URL and payload", () => {
    const result = adaptScheduleTrigger({
      ...base,
      triggerType: "loop",
    });

    expect(result.userId).toBe("user-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.scheduleId).toBe("sched-1");
    expect(result.prompt).toBe("hello");
    expect(result.appendSystemPrompt).toBe("sys");
    expect(result.triggerSource).toBe("schedule");

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(/\/api\/internal\/callbacks\/schedule\/loop$/);
    expect(callback.payload).toEqual({ scheduleId: "sched-1" });
    expect(typeof callback.secret).toBe("string");
    expect(callback.secret.length).toBeGreaterThan(0);
  });

  it("maps cron trigger to cron callback URL and full payload", () => {
    const result = adaptScheduleTrigger({
      ...base,
      triggerType: "cron",
      cronExpression: "*/5 * * * *",
      timezone: "America/New_York",
    });

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(/\/api\/internal\/callbacks\/schedule\/cron$/);
    expect(callback.payload).toEqual({
      scheduleId: "sched-1",
      cronExpression: "*/5 * * * *",
      timezone: "America/New_York",
    });
  });

  it("maps once trigger to cron callback URL (shared path)", () => {
    const result = adaptScheduleTrigger({
      ...base,
      triggerType: "once",
      cronExpression: undefined,
      timezone: "UTC",
    });

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(callback.url).toMatch(/\/api\/internal\/callbacks\/schedule\/cron$/);
    expect(callback.payload).toEqual({
      scheduleId: "sched-1",
      timezone: "UTC",
    });
    expect(Object.keys(callback.payload as object)).not.toContain(
      "cronExpression",
    );
  });

  it("omits cronExpression from cron payload when undefined", () => {
    const result = adaptScheduleTrigger({
      ...base,
      triggerType: "cron",
      cronExpression: undefined,
    });

    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect(Object.keys(callback.payload as object)).not.toContain(
      "cronExpression",
    );
  });

  it("propagates scheduleId to both top-level field and callback payload", () => {
    const result = adaptScheduleTrigger({
      ...base,
      triggerType: "loop",
      scheduleId: "sched-xyz",
    });
    expect(result.scheduleId).toBe("sched-xyz");
    const callback = result.callbacks?.[0];
    if (!callback) {
      throw new Error("expected exactly one callback");
    }
    expect((callback.payload as { scheduleId: string }).scheduleId).toBe(
      "sched-xyz",
    );
  });

  it("generates a unique secret per call", () => {
    const ctx = { ...base, triggerType: "loop" };
    const a = adaptScheduleTrigger(ctx);
    const b = adaptScheduleTrigger(ctx);
    const aSecret = a.callbacks?.[0]?.secret;
    const bSecret = b.callbacks?.[0]?.secret;
    expect(aSecret).toBeDefined();
    expect(bSecret).toBeDefined();
    expect(aSecret).not.toBe(bSecret);
  });
});
