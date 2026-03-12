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

  it("should pass artifactName and memoryName conventions to createRun", async () => {
    // Given a user with an agent compose (created via API so it has a version)
    const userId = uniqueId("test-user");
    mockClerk({ userId });
    await createTestOrg(uniqueId("org"));
    const { composeId } = await createTestCompose("test-agent");

    // And createRun is spied on to capture the call without executing
    const createRunSpy = vi.spyOn(runModule, "createRun").mockResolvedValue({
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

    // And createRun should receive artifactName: "artifact"
    expect(createRunSpy).toHaveBeenCalledTimes(1);
    const callArgs = createRunSpy.mock.calls[0]![0] as {
      prompt: string;
      artifactName: string;
      memoryName: string;
    };
    expect(callArgs).toMatchObject({
      artifactName: "artifact",
      memoryName: "memory",
    });

    // And the prompt should contain integration context
    expect(callArgs.prompt).toContain(
      "You are currently running inside: Slack",
    );
    expect(callArgs.prompt).toContain("help me");
  });
});
