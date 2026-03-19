import { describe, it, expect, vi, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestOrg,
} from "../../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import * as runModule from "../../../run";
import { runAgentForSlack } from "../run-agent";
import type { SlackCallbackContext } from "../run-agent";

const context = testContext();

describe("runAgentForSlack", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should call startRun with correct composeId and prompt", async () => {
    // Given a user with an agent compose (created via API so it has a version)
    const userId = uniqueId("test-user");
    mockClerk({ userId });
    await createTestOrg(uniqueId("org"));
    const { composeId } = await createTestCompose("test-agent");

    // And startRun is spied on to capture the call without executing
    const startRunSpy = vi.spyOn(runModule, "startRun").mockResolvedValue({
      runId: "mock-run-id",
      status: "running",
      createdAt: new Date(),
    });

    const callbackContext: SlackCallbackContext = {
      workspaceId: uniqueId("T"),
      channelId: uniqueId("C"),
      threadTs: "1000000000.000000",
      messageTs: "1000000001.000000",
      userLinkId: uniqueId("link"),
      agentName: "test-agent",
      composeId,
    };

    // When runAgentForSlack is called
    const result = await runAgentForSlack({
      composeId,
      agentName: "test-agent",
      sessionId: undefined,
      prompt: "help me",
      threadContext: "",
      userId,
      callbackContext,
    });

    // Then the run should be dispatched
    expect(result.status).toBe("dispatched");

    // And startRun should receive the correct composeId and prompt
    expect(startRunSpy).toHaveBeenCalledTimes(1);
    const callArgs = startRunSpy.mock.calls[0]![0] as {
      composeId: string;
      prompt: string;
    };
    expect(callArgs.composeId).toBe(composeId);

    // And the prompt should contain integration context
    expect(callArgs.prompt).toContain(
      "You are currently running inside: Slack",
    );
    expect(callArgs.prompt).toContain("help me");
  });
});
