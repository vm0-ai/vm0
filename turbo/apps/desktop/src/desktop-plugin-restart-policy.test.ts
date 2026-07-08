import { describe, expect, it } from "vitest";
import { PluginRestartPolicy } from "./desktop-plugin-restart-policy";

function createPolicy(options: { readonly stableUptimeMs?: number } = {}) {
  let nowMs = 0;
  const policy = new PluginRestartPolicy({
    delaysMs: [1_000, 5_000, 30_000],
    stableUptimeMs: options.stableUptimeMs ?? 60_000,
    now: () => nowMs,
  });
  return {
    policy,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("PluginRestartPolicy", () => {
  it("returns backoff delays in order and null once the budget is exhausted", () => {
    const { policy } = createPolicy();
    expect(policy.nextDelayMs()).toBe(1_000);
    expect(policy.nextDelayMs()).toBe(5_000);
    expect(policy.nextDelayMs()).toBe(30_000);
    expect(policy.nextDelayMs()).toBeNull();
    expect(policy.nextDelayMs()).toBeNull();
  });

  it("keeps consuming the budget when the process never starts", () => {
    const { policy, advance } = createPolicy();
    expect(policy.nextDelayMs()).toBe(1_000);
    advance(120_000);
    expect(policy.nextDelayMs()).toBe(5_000);
    expect(policy.nextDelayMs()).toBe(30_000);
    expect(policy.nextDelayMs()).toBeNull();
  });

  it("does not reset the budget after a short-lived start", () => {
    const { policy, advance } = createPolicy();
    expect(policy.nextDelayMs()).toBe(1_000);
    policy.notifyStarted();
    advance(10_000);
    expect(policy.nextDelayMs()).toBe(5_000);
    expect(policy.nextDelayMs()).toBe(30_000);
    expect(policy.nextDelayMs()).toBeNull();
  });

  it("resets the budget after a stable uptime window", () => {
    const { policy, advance } = createPolicy();
    expect(policy.nextDelayMs()).toBe(1_000);
    expect(policy.nextDelayMs()).toBe(5_000);
    policy.notifyStarted();
    advance(60_000);
    expect(policy.nextDelayMs()).toBe(1_000);
    expect(policy.nextDelayMs()).toBe(5_000);
    expect(policy.nextDelayMs()).toBe(30_000);
    expect(policy.nextDelayMs()).toBeNull();
  });

  it("resets the budget explicitly", () => {
    const { policy } = createPolicy();
    expect(policy.nextDelayMs()).toBe(1_000);
    expect(policy.nextDelayMs()).toBe(5_000);
    policy.reset();
    expect(policy.nextDelayMs()).toBe(1_000);
  });

  it("uses each stable uptime only once", () => {
    const { policy, advance } = createPolicy();
    expect(policy.nextDelayMs()).toBe(1_000);
    policy.notifyStarted();
    advance(60_000);
    expect(policy.nextDelayMs()).toBe(1_000);
    expect(policy.nextDelayMs()).toBe(5_000);
    expect(policy.nextDelayMs()).toBe(30_000);
    expect(policy.nextDelayMs()).toBeNull();
  });
});
