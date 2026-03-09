import { describe, it, expect, vi, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  createTestScope,
} from "../../../../__tests__/api-test-helpers";
import { mockClerk } from "../../../../__tests__/clerk-mock";
import * as runModule from "../../../run";
import { runAgentForTelegram } from "../run-agent";
import type { TelegramCallbackContext } from "../run-agent";

const context = testContext();

describe("runAgentForTelegram", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should pass artifactName and memoryName conventions to createRun", async () => {
    // Given a user with an agent compose (created via API so it has a version)
    const userId = uniqueId("test-user");
    mockClerk({ userId });
    await createTestScope(uniqueId("scope"));
    const { composeId } = await createTestCompose("test-agent");

    // And createRun is spied on to capture the call without executing
    const createRunSpy = vi.spyOn(runModule, "createRun").mockResolvedValue({
      runId: "mock-run-id",
      status: "running",
      createdAt: new Date(),
    });

    const callbackContext: TelegramCallbackContext = {
      installationId: uniqueId("install"),
      chatId: uniqueId("chat"),
      messageId: uniqueId("msg"),
      rootMessageId: null,
      userLinkId: uniqueId("link"),
      agentName: "test-agent",
      composeId,
      existingSessionId: null,
      isDM: true,
      thinkingMessageId: null,
    };

    // When runAgentForTelegram is called
    const result = await runAgentForTelegram({
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

    // And createRun should receive artifactName and memoryName
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
      "You are currently running inside: Telegram",
    );
    expect(callArgs.prompt).toContain("help me");
  });
});
