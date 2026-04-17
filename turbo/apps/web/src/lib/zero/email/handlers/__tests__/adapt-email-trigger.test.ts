import { describe, it, expect } from "vitest";
import { adaptEmailTriggerTrigger } from "../adapt-email-trigger";
import { buildIntegrationPrompt } from "../../../integration-prompt";

function buildContext(
  overrides: Partial<Parameters<typeof adaptEmailTriggerTrigger>[0]> = {},
): Parameters<typeof adaptEmailTriggerTrigger>[0] {
  return {
    userId: "user-123",
    agentId: "agent-abc",
    prompt: "Subject line\n\nBody content",
    callbackPayload: {
      senderEmail: "sender@example.com",
      agentId: "agent-abc",
      userId: "user-123",
      inboundEmailId: "email-1",
      replyToken: "session-uuid.abcdef0123456789",
      inboundMessageId: "<msg@example.com>",
      inboundReferences: undefined,
      subject: "Subject line",
      runtimeOrgId: "org-1",
      replyRecipientTo: ["sender@example.com"],
      replyRecipientCc: [],
    },
    ...overrides,
  };
}

describe("adaptEmailTriggerTrigger", () => {
  it("returns CreateZeroRunParams with triggerSource 'email'", () => {
    const result = adaptEmailTriggerTrigger(buildContext());
    expect(result.triggerSource).toBe("email");
  });

  it("propagates identity and prompt fields", () => {
    const ctx = buildContext();
    const result = adaptEmailTriggerTrigger(ctx);
    expect(result.userId).toBe(ctx.userId);
    expect(result.agentId).toBe(ctx.agentId);
    expect(result.prompt).toBe(ctx.prompt);
  });

  it("does not set sessionId (trigger flow starts a fresh session)", () => {
    const result = adaptEmailTriggerTrigger(buildContext());
    expect(result.sessionId).toBeUndefined();
  });

  it("sets appendSystemPrompt to Email integration prompt", () => {
    const result = adaptEmailTriggerTrigger(buildContext());
    expect(result.appendSystemPrompt).toBe(buildIntegrationPrompt("Email"));
  });

  it("builds a single trigger callback with correct URL", () => {
    const result = adaptEmailTriggerTrigger(buildContext());
    expect(result.callbacks).toHaveLength(1);
    expect(result.callbacks?.[0]?.url).toMatch(
      /\/api\/zero\/email\/callbacks\/trigger$/,
    );
  });

  it("generates a 64-character hex callback secret", () => {
    const result = adaptEmailTriggerTrigger(buildContext());
    expect(result.callbacks?.[0]?.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forwards callbackPayload verbatim", () => {
    const ctx = buildContext();
    const result = adaptEmailTriggerTrigger(ctx);
    expect(result.callbacks?.[0]?.payload).toEqual(ctx.callbackPayload);
  });

  it("generates a fresh secret per invocation (pure except for secret/env)", () => {
    const ctx = buildContext();
    const r1 = adaptEmailTriggerTrigger(ctx);
    const r2 = adaptEmailTriggerTrigger(ctx);
    expect(r1.userId).toBe(r2.userId);
    expect(r1.prompt).toBe(r2.prompt);
    expect(r1.callbacks?.[0]?.secret).not.toBe(r2.callbacks?.[0]?.secret);
  });
});
