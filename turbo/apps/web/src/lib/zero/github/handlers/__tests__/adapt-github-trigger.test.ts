import { describe, it, expect } from "vitest";
import { adaptGithubTrigger } from "../adapt-github-trigger";

function buildContext(
  overrides: Partial<Parameters<typeof adaptGithubTrigger>[0]> = {},
): Parameters<typeof adaptGithubTrigger>[0] {
  return {
    userId: "user-123",
    agentId: "agent-abc",
    sessionId: "session-xyz",
    prompt: "Please investigate this issue",
    appendSystemPrompt: "# GitHub Issue Context\n\n...",
    apiStartTime: 1000,
    callbackPayload: {
      installationId: "install-row-1",
      repo: "vm0-ai/vm0",
      issueNumber: 9730,
      agentId: "compose-id-1",
      existingSessionId: "session-xyz",
      triggerCommentId: "123456",
      triggerCommentBody: "@bot help",
      triggerReactionId: "987654",
    },
    ...overrides,
  };
}

describe("adaptGithubTrigger", () => {
  it("returns CreateZeroRunParams with triggerSource 'github'", () => {
    expect(adaptGithubTrigger(buildContext()).triggerSource).toBe("github");
  });

  it("propagates identity, prompt, session and appendSystemPrompt fields", () => {
    const ctx = buildContext();
    const result = adaptGithubTrigger(ctx);
    expect(result.userId).toBe(ctx.userId);
    expect(result.agentId).toBe(ctx.agentId);
    expect(result.sessionId).toBe(ctx.sessionId);
    expect(result.prompt).toBe(ctx.prompt);
    expect(result.appendSystemPrompt).toBe(ctx.appendSystemPrompt);
  });

  it("forwards apiStartTime", () => {
    const ctx = buildContext();
    const result = adaptGithubTrigger(ctx);
    expect(result.apiStartTime).toBe(ctx.apiStartTime);
  });

  it("passes through undefined sessionId for a new session", () => {
    const result = adaptGithubTrigger(buildContext({ sessionId: undefined }));
    expect(result.sessionId).toBeUndefined();
  });

  it("passes through undefined appendSystemPrompt", () => {
    const result = adaptGithubTrigger(
      buildContext({ appendSystemPrompt: undefined }),
    );
    expect(result.appendSystemPrompt).toBeUndefined();
  });

  it("builds a single callback with the github issues callback URL", () => {
    const result = adaptGithubTrigger(buildContext());
    expect(result.callbacks).toHaveLength(1);
    expect(result.callbacks?.[0]?.url).toMatch(
      /\/api\/internal\/callbacks\/github\/issues$/,
    );
  });

  it("generates a 64-character hex callback secret", () => {
    const result = adaptGithubTrigger(buildContext());
    expect(result.callbacks?.[0]?.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("forwards callbackPayload verbatim", () => {
    const ctx = buildContext();
    const result = adaptGithubTrigger(ctx);
    expect(result.callbacks?.[0]?.payload).toEqual(ctx.callbackPayload);
  });

  it("generates a fresh secret per invocation (pure except for secret/env)", () => {
    const ctx = buildContext();
    const r1 = adaptGithubTrigger(ctx);
    const r2 = adaptGithubTrigger(ctx);
    expect(r1.userId).toBe(r2.userId);
    expect(r1.prompt).toBe(r2.prompt);
    expect(r1.callbacks?.[0]?.secret).not.toBe(r2.callbacks?.[0]?.secret);
  });
});
