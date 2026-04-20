import { describe, it, expect } from "vitest";
import { adaptEmailReplyTrigger } from "../adapt-email-reply";
import { buildIntegrationPrompt } from "../../../integration-prompt";

function buildContext(
  overrides: Partial<Parameters<typeof adaptEmailReplyTrigger>[0]> = {},
): Parameters<typeof adaptEmailReplyTrigger>[0] {
  return {
    userId: "user-123",
    agentId: "agent-abc",
    sessionId: "session-xyz",
    prompt: "Hello agent",
    apiStartTime: 1000,
    callbackPayload: {
      emailThreadSessionId: "thread-1",
      inboundEmailId: "email-1",
      inboundMessageId: "<msg@example.com>",
      inboundReferences: "<a@x> <b@x>",
      replyRecipientTo: ["user@example.com"],
      replyRecipientCc: ["cc@example.com"],
    },
    ...overrides,
  };
}

describe("adaptEmailReplyTrigger", () => {
  it("returns CreateZeroRunParams with triggerSource 'email'", () => {
    const result = adaptEmailReplyTrigger(buildContext());
    expect(result.triggerSource).toBe("email");
  });

  it("propagates identity and prompt fields", () => {
    const ctx = buildContext();
    const result = adaptEmailReplyTrigger(ctx);
    expect(result.userId).toBe(ctx.userId);
    expect(result.agentId).toBe(ctx.agentId);
    expect(result.sessionId).toBe(ctx.sessionId);
    expect(result.prompt).toBe(ctx.prompt);
  });

  it("forwards apiStartTime", () => {
    const ctx = buildContext();
    const result = adaptEmailReplyTrigger(ctx);
    expect(result.apiStartTime).toBe(ctx.apiStartTime);
  });

  it("sets appendSystemPrompt to Email integration prompt", () => {
    const result = adaptEmailReplyTrigger(buildContext());
    expect(result.appendSystemPrompt).toBe(buildIntegrationPrompt("Email"));
  });

  it("builds a single reply callback with correct URL", () => {
    const result = adaptEmailReplyTrigger(buildContext());
    expect(result.callbacks).toHaveLength(1);
    expect(result.callbacks?.[0]?.url).toMatch(
      /\/api\/zero\/email\/callbacks\/reply$/,
    );
  });

  it("generates a 64-character hex callback secret", () => {
    const result = adaptEmailReplyTrigger(buildContext());
    expect(result.callbacks?.[0]?.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forwards callbackPayload verbatim", () => {
    const ctx = buildContext();
    const result = adaptEmailReplyTrigger(ctx);
    expect(result.callbacks?.[0]?.payload).toEqual(ctx.callbackPayload);
  });

  it("generates a fresh secret per invocation (pure except for secret/env)", () => {
    const ctx = buildContext();
    const r1 = adaptEmailReplyTrigger(ctx);
    const r2 = adaptEmailReplyTrigger(ctx);
    // Identity fields stable
    expect(r1.userId).toBe(r2.userId);
    expect(r1.prompt).toBe(r2.prompt);
    // Secrets differ per invocation (cryptographically random)
    expect(r1.callbacks?.[0]?.secret).not.toBe(r2.callbacks?.[0]?.secret);
  });
});
