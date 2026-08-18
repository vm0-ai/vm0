import { screen } from "@testing-library/react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { context, detachedSetupPage } from "./chat-lifecycle-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000211";
const RUN_ID = "run-inline-thinking-blocks";
const COMPLETED_THREAD_ID = "b0000000-0000-4000-a000-000000000212";
const COMPLETED_RUN_ID = "run-completed-inline-thinking-blocks";

function thinkingSummaries(): HTMLElement[] {
  const summaries = screen
    .getAllByText("Thinking")
    .map((label) => {
      return label.closest("summary");
    })
    .filter((summary): summary is HTMLElement => {
      return summary instanceof HTMLElement;
    });

  return [...new Set(summaries)];
}

function thinkingContent(text: string): HTMLElement {
  const content = screen.getAllByText(text).find((candidate) => {
    return candidate.closest("summary") === null;
  });
  if (!content) {
    throw new Error(`Expanded thinking copy was not rendered: ${text}`);
  }
  return content;
}

function expectBefore(before: HTMLElement, after: HTMLElement): void {
  expect(
    before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

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
      featureSwitches: {
        [FeatureSwitchKey.ChatInlineThinkingBlocks]: true,
      },
    });

    await screen.findByText("I loaded the trial accounts.");
    const messageOne = screen.getByText("I loaded the trial accounts.");
    const messageTwo = screen.getByText(
      "The strongest split is second-workflow activation.",
    );
    const summaries = thinkingSummaries();
    expect(summaries).toHaveLength(2);
    const firstSummary = summaries[0];
    const secondSummary = summaries[1];
    if (!firstSummary || !secondSummary) {
      throw new Error("Thinking block summaries were not rendered");
    }
    const firstContent = thinkingContent(
      "Comparing retained and churned trial cohorts.",
    );
    const secondContent = thinkingContent(
      "Checking whether collaboration changes the result.",
    );

    expectBefore(firstSummary, messageOne);
    expectBefore(messageOne, messageTwo);
    expectBefore(messageTwo, secondSummary);
    expect(firstContent).not.toBeVisible();
    expect(secondContent).toBeVisible();

    await user.click(firstSummary);
    expect(firstContent).toBeVisible();
    expect(secondContent).toBeVisible();

    await user.click(secondSummary);
    expect(firstContent).toBeVisible();
    expect(secondContent).not.toBeVisible();
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
      featureSwitches: {
        [FeatureSwitchKey.ChatInlineThinkingBlocks]: true,
      },
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
    expect(
      screen.queryByText("Comparing expansion by customer cohort."),
    ).toBeNull();
    expect(
      screen.queryByText("Checking whether seat growth explains the result."),
    ).toBeNull();

    await user.click(expandButton);
    await screen.findAllByText("Comparing expansion by customer cohort.");

    const summaries = thinkingSummaries();
    expect(summaries).toHaveLength(2);
    const firstSummary = summaries[0];
    const secondSummary = summaries[1];
    const messageOne = screen.getByText("I loaded the expansion records.");
    const messageTwo = screen.getByText(
      "The enterprise cohort leads the increase.",
    );
    const result = screen.getByText(
      "Expansion revenue grew 18%, led by enterprise accounts.",
    );
    if (!firstSummary || !secondSummary) {
      throw new Error("Completed thinking summaries were not rendered");
    }
    const firstContent = thinkingContent(
      "Comparing expansion by customer cohort.",
    );
    const secondContent = thinkingContent(
      "Checking whether seat growth explains the result.",
    );

    expectBefore(firstSummary, messageOne);
    expectBefore(messageOne, messageTwo);
    expectBefore(messageTwo, secondSummary);
    expectBefore(secondSummary, result);
    expect(firstContent).not.toBeVisible();
    expect(secondContent).not.toBeVisible();

    await user.click(firstSummary);
    expect(firstContent).toBeVisible();
    expect(secondContent).not.toBeVisible();

    await user.click(secondSummary);
    expect(firstContent).toBeVisible();
    expect(secondContent).toBeVisible();
  });

  it("keeps thinking events on the legacy presentation while the switch is off", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000213";
    const runId = "run-legacy-thinking-presentation";
    mockChatLifecycle(context, {
      threadId,
      activeRunIds: [runId],
      chatEvents: [
        {
          id: "msg-legacy-thinking-user",
          role: "user",
          content: "Summarize the account",
          runId,
          createdAt: "2026-08-18T10:00:00Z",
        },
        {
          id: "msg-legacy-thinking-marker",
          role: "assistant",
          content: null,
          thinking: "This thought stays out of the transcript.",
          runId,
          createdAt: "2026-08-18T10:00:01Z",
        },
        {
          id: "msg-legacy-thinking-result",
          role: "assistant",
          content: "Here is the account summary.",
          runId,
          createdAt: "2026-08-18T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatInlineThinkingBlocks]: false,
      },
    });

    await screen.findByText("Here is the account summary.");
    expect(
      screen.queryByText("This thought stays out of the transcript."),
    ).toBeNull();
  });

  it("keeps completed thinking history on the legacy presentation while the switch is off", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000214";
    const runId = "run-completed-legacy-thinking-presentation";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-completed-legacy-thinking-user",
          role: "user",
          content: "Summarize the legacy account",
          runId,
          createdAt: "2026-08-18T10:00:00Z",
        },
        {
          id: "msg-completed-legacy-thinking-marker",
          role: "assistant",
          content: null,
          thinking: "This completed thought stays out of the transcript.",
          runId,
          createdAt: "2026-08-18T10:00:01Z",
        },
        {
          id: "msg-completed-legacy-thinking-result",
          role: "assistant",
          content: "Here is the completed legacy account summary.",
          runId,
          runLifecycleEvent: "completed",
          createdAt: "2026-08-18T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatInlineThinkingBlocks]: false,
      },
    });

    await screen.findByText("Here is the completed legacy account summary.");
    expect(screen.getByText("Summarize the legacy account")).toBeVisible();
    expect(
      screen.queryByText("This completed thought stays out of the transcript."),
    ).toBeNull();
    expect(screen.queryByLabelText("Expand work history")).toBeNull();
    expect(screen.queryByText("Worked for 5s")).toBeNull();
  });
});
