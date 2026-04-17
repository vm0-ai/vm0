import { describe, expect, it } from "vitest";
import type { SlackOrgCallbackPayload } from "../../../../infra/callback/callback-payloads";
import {
  adaptSlackTrigger,
  type SlackTriggerContext,
} from "../adapt-slack-trigger";

const payload: SlackOrgCallbackPayload = {
  workspaceId: "T-ws",
  channelId: "C-123",
  threadTs: "1.2",
  messageTs: "1.3",
  connectionId: "conn-1",
  agentId: "compose-1",
};

function baseCtx(
  overrides: Partial<SlackTriggerContext> = {},
): SlackTriggerContext {
  return {
    userId: "user-1",
    agentId: "agent-1",
    sessionId: undefined,
    prompt: "hello",
    threadContext: "",
    botUserId: "U-BOT",
    channelId: "C-123",
    channelType: "channel",
    threadTs: "1.2",
    callbackContext: payload,
    ...overrides,
  };
}

describe("adaptSlackTrigger", () => {
  it("produces createZeroRun params with Slack callback wired up", () => {
    const out = adaptSlackTrigger(
      baseCtx({ threadContext: "prior messages..." }),
      "fixed-secret",
    );

    expect(out.triggerSource).toBe("slack");
    expect(out.userId).toBe("user-1");
    expect(out.agentId).toBe("agent-1");
    expect(out.prompt).toBe("hello");
    expect(out.sessionId).toBeUndefined();

    expect(out.appendSystemPrompt).toContain("# Current Integration");
    expect(out.appendSystemPrompt).toContain("Slack");
    expect(out.appendSystemPrompt).toContain("U-BOT");
    expect(out.appendSystemPrompt).toContain("C-123");
    expect(out.appendSystemPrompt?.endsWith("prior messages...")).toBe(true);

    expect(out.callbacks).toHaveLength(1);
    expect(out.callbacks?.[0].url).toMatch(
      /\/api\/internal\/callbacks\/slack\/org$/,
    );
    expect(out.callbacks?.[0].secret).toBe("fixed-secret");
    expect(out.callbacks?.[0].payload).toBe(payload);
  });

  it("keeps the integration header even when threadContext is empty", () => {
    const out = adaptSlackTrigger(baseCtx({ threadContext: "" }), "s");
    expect(out.appendSystemPrompt).toContain("# Current Integration");
    expect(out.appendSystemPrompt).not.toBe("");
  });

  it("forwards userInfoExtras unchanged", () => {
    const extras = { name: "Ada", email: "ada@example.com" };
    const out = adaptSlackTrigger(baseCtx({ userInfoExtras: extras }), "s");
    expect(out.userInfoExtras).toBe(extras);
  });

  it("is deterministic when secret is supplied", () => {
    const ctx = baseCtx();
    const a = adaptSlackTrigger(ctx, "same");
    const b = adaptSlackTrigger(ctx, "same");
    expect(a).toEqual(b);
  });

  it("omits channel fields from header when not provided", () => {
    const out = adaptSlackTrigger(
      baseCtx({
        channelId: undefined,
        channelType: undefined,
        threadTs: undefined,
      }),
      "s",
    );
    expect(out.appendSystemPrompt).toContain("# Current Integration");
    expect(out.appendSystemPrompt).not.toContain("Channel ID");
    expect(out.appendSystemPrompt).not.toContain("Channel type");
    expect(out.appendSystemPrompt).not.toContain("Thread ID");
  });
});
