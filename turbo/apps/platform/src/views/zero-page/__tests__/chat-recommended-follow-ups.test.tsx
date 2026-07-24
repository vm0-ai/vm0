import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { click } from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  FOLLOWUP_THREAD_ID,
  HISTORY_THREAD_ID,
  buttonByText,
  queryButtonByText,
} from "./chat-lifecycle-test-helpers.ts";

describe("chat lifecycle", () => {
  it("shows an empty artifact inbox from the chat header", async () => {
    mockChatLifecycle(context, {
      threadId: HISTORY_THREAD_ID,
      threadTitle: "Artifact inventory",
      chatMessages: [
        {
          id: "msg-empty-artifacts",
          role: "assistant",
          content: "No files were produced for this request.",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });

    detachedSetupPage({ context, path: `/chats/${HISTORY_THREAD_ID}` });

    click(await screen.findByLabelText("Open artifacts"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
      expect(
        screen.getByText("No uploaded files in this chat yet."),
      ).toBeInTheDocument();
    });
  });
  it("sends a recommended follow-up from the latest assistant reply", async () => {
    const assistantReply = "I can turn this into a launch package.";
    const followupPrompt = "Create a presentation outline";
    const completedAt = "2026-06-09T10:01:01Z";
    const completedAtLabel = new Date(completedAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const sendGate = context.mocks.deferred<void>();
    const sentMessages: {
      prompt?: string;
      revokesMessageId?: string;
      structuredPrompt?: unknown;
    }[] = [];

    mockChatLifecycle(context, {
      threadId: FOLLOWUP_THREAD_ID,
      threadTitle: "Launch package",
      sendGate: sendGate.promise,
      chatMessages: [
        {
          id: "msg-followup-user",
          role: "user",
          content: "Package this launch plan",
          runId: "run-followup",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-followup",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-followup-completed",
          role: "assistant",
          content: null,
          runId: "run-followup",
          runLifecycleEvent: "completed",
          recommendedFollowups: [
            {
              prompt: followupPrompt,
              kind: "generate",
              generationType: "presentation",
            },
            {
              prompt: "Generate hero image",
              kind: "generate",
              generationType: "image",
            },
            {
              prompt: "Generate launch video",
              kind: "generate",
              generationType: "video",
            },
            {
              prompt: "Generate launch website",
              kind: "generate",
              generationType: "website",
            },
            {
              prompt: "Generate launch artifact",
              kind: "generate",
            },
            {
              prompt: "Draft launch copy",
              kind: "talk",
            },
          ],
          createdAt: completedAt,
        },
      ],
      onRunCreate: (body) => {
        sentMessages.push(body);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FOLLOWUP_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.StructuredPrompt]: true },
    });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
      expect(
        screen.getByText(`Keep going · ${completedAtLabel}`),
      ).toBeInTheDocument();
      expect(buttonByText(followupPrompt)).toBeInTheDocument();
      expect(buttonByText("Generate hero image")).toBeInTheDocument();
      expect(buttonByText("Generate launch video")).toBeInTheDocument();
      expect(buttonByText("Generate launch website")).toBeInTheDocument();
      expect(buttonByText("Generate launch artifact")).toBeInTheDocument();
      expect(buttonByText("Draft launch copy")).toBeInTheDocument();
    });

    click(buttonByText(followupPrompt));

    await waitFor(() => {
      expect(queryButtonByText(followupPrompt)).not.toBeInTheDocument();
      expect(screen.getByText(followupPrompt)).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    expect(sentMessages).toHaveLength(0);

    sendGate.resolve();

    await waitFor(() => {
      expect(sentMessages).toHaveLength(1);
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    expect(sentMessages[0]).toMatchObject({ prompt: followupPrompt });
    expect(sentMessages[0]?.revokesMessageId).toBeUndefined();
    expect(sentMessages[0]?.structuredPrompt).toStrictEqual({
      version: 1,
      parts: [{ type: "text", text: followupPrompt }],
    });
  });

  it("restores an appended queued-message claim after refresh", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000731";
    const queuedMessageId = "00000000-0000-4000-8000-000000004031";
    const claimedMessageId = "00000000-0000-4000-8000-000000004032";
    const runId = "run-queue-first-claimed";
    const prompt = "Run this message immediately";

    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: queuedMessageId,
          role: "user",
          content: prompt,
          runId: undefined,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: claimedMessageId,
          role: "user",
          content: prompt,
          runId,
          revokesMessageId: queuedMessageId,
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
      activeRunIds: [runId],
    });

    // Optimistic sends are not persisted to IndexedDB. A refreshed page must
    // recover entirely from the immutable queued row and its replacement.
    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.queryByText("1 message waiting")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.getByText(prompt)).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("hides recommended follow-ups after a newer assistant reply", async () => {
    const firstAssistantReply = "I can turn this into a launch package.";
    const newerAssistantReply = "Here is the newer launch package.";
    const followupPrompt = "Create a presentation outline";

    mockChatLifecycle(context, {
      threadId: FOLLOWUP_THREAD_ID,
      threadTitle: "Launch package",
      chatMessages: [
        {
          id: "msg-followup-old-user",
          role: "user",
          content: "Package this launch plan",
          runId: "run-followup-old",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-old-assistant",
          role: "assistant",
          content: firstAssistantReply,
          runId: "run-followup-old",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-followup-old-completed",
          role: "assistant",
          content: null,
          runId: "run-followup-old",
          runLifecycleEvent: "completed",
          recommendedFollowups: [
            {
              prompt: followupPrompt,
              kind: "generate",
              generationType: "presentation",
            },
          ],
          createdAt: "2026-06-09T10:01:01Z",
        },
        {
          id: "msg-followup-new-user",
          role: "user",
          content: followupPrompt,
          runId: "run-followup-new",
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-followup-new-assistant",
          role: "assistant",
          content: newerAssistantReply,
          runId: "run-followup-new",
          createdAt: "2026-06-09T10:03:00Z",
        },
        {
          id: "msg-followup-new-completed",
          role: "assistant",
          content: null,
          runId: "run-followup-new",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:03:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FOLLOWUP_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText(firstAssistantReply)).toBeInTheDocument();
      expect(screen.getByText(newerAssistantReply)).toBeInTheDocument();
      expect(queryButtonByText(followupPrompt)).not.toBeInTheDocument();
    });
  });
});
