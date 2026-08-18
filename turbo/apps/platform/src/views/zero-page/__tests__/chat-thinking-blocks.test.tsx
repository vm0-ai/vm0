import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000211";
const RUN_ID = "run-inline-thinking-blocks";

describe("chat thinking blocks", () => {
  it("keeps thinking events in transcript order with independent open states", async () => {
    const user = userEvent.setup();
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      activeRunIds: [RUN_ID],
      chatEvents: [
        {
          id: "msg-inline-thinking-user",
          role: "user",
          content: "Analyze trial retention",
          runId: RUN_ID,
          createdAt: "2026-08-18T10:00:00Z",
        },
        {
          id: "msg-inline-thinking-first",
          role: "assistant",
          content: null,
          thinking: "Comparing retained and churned trial cohorts.",
          runId: RUN_ID,
          createdAt: "2026-08-18T10:00:01Z",
        },
        {
          id: "msg-inline-thinking-message-one",
          role: "assistant",
          content: "I loaded the trial accounts.",
          runId: RUN_ID,
          createdAt: "2026-08-18T10:00:02Z",
        },
        {
          id: "msg-inline-thinking-message-two",
          role: "assistant",
          content: "The strongest split is second-workflow activation.",
          runId: RUN_ID,
          createdAt: "2026-08-18T10:00:03Z",
        },
        {
          id: "msg-inline-thinking-second",
          role: "assistant",
          content: null,
          thinking: "Checking whether collaboration changes the result.",
          runId: RUN_ID,
          createdAt: "2026-08-18T10:00:04Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    await screen.findByText("I loaded the trial accounts.");
    const messageOne = screen.getByText("I loaded the trial accounts.");
    const messageTwo = screen.getByText(
      "The strongest split is second-workflow activation.",
    );
    const thinkingBlocks = await waitFor(() => {
      const blocks = document.querySelectorAll<HTMLDetailsElement>(
        "[data-thinking-block]",
      );
      expect(blocks).toHaveLength(2);
      return blocks;
    });

    const firstThinking = thinkingBlocks[0];
    const secondThinking = thinkingBlocks[1];
    if (!firstThinking || !secondThinking) {
      throw new Error("Thinking blocks were not rendered");
    }
    expect(
      firstThinking.compareDocumentPosition(messageOne) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      messageOne.compareDocumentPosition(messageTwo) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      messageTwo.compareDocumentPosition(secondThinking) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(firstThinking.open).toBeFalsy();
    expect(secondThinking.open).toBeTruthy();
    const firstSummary = firstThinking.querySelector("summary");
    const secondSummary = secondThinking.querySelector("summary");
    if (!firstSummary || !secondSummary) {
      throw new Error("Thinking block summaries were not rendered");
    }

    await user.click(firstSummary);
    expect(firstThinking.open).toBeTruthy();
    expect(secondThinking.open).toBeTruthy();

    await user.click(secondSummary);
    expect(firstThinking.open).toBeTruthy();
    expect(secondThinking.open).toBeFalsy();
  });
});
