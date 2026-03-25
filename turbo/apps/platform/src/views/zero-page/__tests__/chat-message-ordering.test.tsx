import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

describe("chat message ordering", () => {
  it("should insert failed run at chronological position when subsequent messages exist", async () => {
    mockChatLifecycle({
      threadId: "thread-ordering-1",
      chatMessages: [
        {
          role: "user",
          content: "First message",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          role: "assistant",
          content: "First reply",
          createdAt: "2026-03-10T00:00:02Z",
        },
        {
          role: "user",
          content: "Third message",
          createdAt: "2026-03-10T00:00:10Z",
        },
        {
          role: "assistant",
          content: "Third reply",
          createdAt: "2026-03-10T00:00:11Z",
        },
      ],
      unsavedRuns: [
        {
          runId: "failed-run-1",
          status: "failed",
          prompt: "Second message",
          error: "Something went wrong",
          createdAt: "2026-03-10T00:00:05Z",
        },
      ],
    });

    await setupPage({ context, path: "/chat/thread-ordering-1" });

    await waitFor(
      () => {
        expect(screen.getByText("First message")).toBeInTheDocument();
        expect(screen.getByText("First reply")).toBeInTheDocument();
        expect(screen.getByText("Second message")).toBeInTheDocument();
        expect(screen.getByText("Third message")).toBeInTheDocument();
        expect(screen.getByText("Third reply")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const firstReply = screen.getByText("First reply");
    const failedPrompt = screen.getByText("Second message");
    const thirdMessage = screen.getByText("Third message");

    // Failed run should appear after "First reply"
    expect(
      firstReply.compareDocumentPosition(failedPrompt) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Failed run should appear before "Third message"
    expect(
      failedPrompt.compareDocumentPosition(thirdMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }, 30_000);

  it("should append failed run to bottom when it is the latest message", async () => {
    mockChatLifecycle({
      threadId: "thread-ordering-2",
      chatMessages: [
        {
          role: "user",
          content: "First message",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          role: "assistant",
          content: "First reply",
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
      unsavedRuns: [
        {
          runId: "failed-run-2",
          status: "failed",
          prompt: "Last message",
          error: "Something went wrong",
          createdAt: "2026-03-10T00:00:10Z",
        },
      ],
    });

    await setupPage({ context, path: "/chat/thread-ordering-2" });

    await waitFor(
      () => {
        expect(screen.getByText("First reply")).toBeInTheDocument();
        expect(screen.getByText("Last message")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const firstReply = screen.getByText("First reply");
    const lastMessage = screen.getByText("Last message");

    // Failed run should appear after "First reply"
    expect(
      firstReply.compareDocumentPosition(lastMessage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }, 30_000);
});
