import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000211";
const RUN_ID = "run-inline-thinking-blocks";
const COMPLETED_THREAD_ID = "b0000000-0000-4000-a000-000000000212";
const COMPLETED_RUN_ID = "run-completed-inline-thinking-blocks";

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
    const firstContent = firstThinking.querySelector(
      "[data-thinking-block-content]",
    );
    expect(firstThinking.parentElement).toHaveClass("-mx-2");
    expect(firstSummary).toHaveClass(
      "inline-flex",
      "px-2",
      "hover:bg-state-hover",
    );
    expect(firstSummary).not.toHaveClass("w-full", "group-open:bg-muted/50");
    expect(firstContent).toHaveClass("text-muted-foreground/80");
    expect(firstContent).not.toHaveClass("bg-muted/50");

    await user.click(firstSummary);
    expect(firstThinking.open).toBeTruthy();
    expect(secondThinking.open).toBeTruthy();

    await user.click(secondSummary);
    expect(firstThinking.open).toBeTruthy();
    expect(secondThinking.open).toBeFalsy();
  });

  it("folds completed thinking and intermediate messages behind the final result", async () => {
    const user = userEvent.setup();
    mockChatLifecycle(context, {
      threadId: COMPLETED_THREAD_ID,
      chatEvents: [
        {
          id: "msg-completed-thinking-user",
          role: "user",
          content: "Analyze expansion revenue",
          runId: COMPLETED_RUN_ID,
          createdAt: "2026-08-18T10:00:00Z",
        },
        {
          id: "msg-completed-thinking-first",
          role: "assistant",
          content: null,
          thinking: "Comparing expansion by customer cohort.",
          runId: COMPLETED_RUN_ID,
          createdAt: "2026-08-18T10:00:05Z",
        },
        {
          id: "msg-completed-thinking-message-one",
          role: "assistant",
          content: "I loaded the expansion records.",
          runId: COMPLETED_RUN_ID,
          createdAt: "2026-08-18T10:00:15Z",
        },
        {
          id: "msg-completed-thinking-message-two",
          role: "assistant",
          content: "The enterprise cohort leads the increase.",
          runId: COMPLETED_RUN_ID,
          createdAt: "2026-08-18T10:00:25Z",
        },
        {
          id: "msg-completed-thinking-second",
          role: "assistant",
          content: null,
          thinking: "Checking whether seat growth explains the result.",
          runId: COMPLETED_RUN_ID,
          createdAt: "2026-08-18T10:00:35Z",
        },
        {
          id: "msg-completed-thinking-result",
          role: "assistant",
          content: "Expansion revenue grew 18%, led by enterprise accounts.",
          runId: COMPLETED_RUN_ID,
          runLifecycleEvent: "completed",
          createdAt: "2026-08-18T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${COMPLETED_THREAD_ID}`,
    });

    const expandButton = await screen.findByLabelText("Expand work history");
    expect(expandButton).toHaveTextContent("Worked for 1m");
    expect(screen.getByText("Analyze expansion revenue")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Expansion revenue grew 18%, led by enterprise accounts.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("I loaded the expansion records.")).toBeNull();
    expect(
      screen.queryByText("The enterprise cohort leads the increase."),
    ).toBeNull();
    expect(document.querySelectorAll("[data-thinking-block]")).toHaveLength(0);

    await user.click(expandButton);

    const thinkingBlocks = await waitFor(() => {
      const blocks = document.querySelectorAll<HTMLDetailsElement>(
        "[data-thinking-block]",
      );
      expect(blocks).toHaveLength(2);
      return blocks;
    });
    const firstThinking = thinkingBlocks[0];
    const secondThinking = thinkingBlocks[1];
    const messageOne = screen.getByText("I loaded the expansion records.");
    const messageTwo = screen.getByText(
      "The enterprise cohort leads the increase.",
    );
    const result = screen.getByText(
      "Expansion revenue grew 18%, led by enterprise accounts.",
    );
    if (!firstThinking || !secondThinking) {
      throw new Error("Completed thinking blocks were not rendered");
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
    expect(
      secondThinking.compareDocumentPosition(result) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(firstThinking.open).toBeFalsy();
    expect(secondThinking.open).toBeFalsy();

    const firstSummary = firstThinking.querySelector("summary");
    const secondSummary = secondThinking.querySelector("summary");
    if (!firstSummary || !secondSummary) {
      throw new Error("Completed thinking summaries were not rendered");
    }
    await user.click(firstSummary);
    expect(firstThinking.open).toBeTruthy();
    expect(secondThinking.open).toBeFalsy();

    await user.click(secondSummary);
    expect(firstThinking.open).toBeTruthy();
    expect(secondThinking.open).toBeTruthy();
  });
});
