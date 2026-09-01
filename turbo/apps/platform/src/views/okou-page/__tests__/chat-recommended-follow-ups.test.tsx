import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { createChatEvent } from "../../../mocks/mock-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  FOLLOWUP_THREAD_ID,
  HISTORY_THREAD_ID,
  buttonByText,
  findWorkflowComposerEditor,
  queryButtonByText,
} from "./chat-lifecycle-test-helpers.ts";

describe("chat lifecycle", () => {
  it("shows an empty artifact inbox from the chat header", async () => {
    mockChatLifecycle(context, {
      threadId: HISTORY_THREAD_ID,
      threadTitle: "Artifact inventory",
      chatEvents: [
        {
          id: "msg-empty-artifacts",
          eventType: "output.message" as const,
          role: "assistant",
          content: "No files were produced for this request.",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [], nextCursor: null });
    });

    detachedSetupPage({ context, path: `/chats/${HISTORY_THREAD_ID}` });

    click(await screen.findByLabelText("Open artifacts"));

    await waitFor(() => {
      expect(
        screen.getByTestId("thread-sidebar-artifacts"),
      ).toBeInTheDocument();
      expect(screen.getByText("No artifacts found")).toBeInTheDocument();
    });
  });
  it("selects or appends a recommended follow-up without sending it", async () => {
    const assistantReply = "I can turn this into a launch package.";
    const followupPrompt = "Create a presentation outline";
    const existingDraft = "Keep the current launch context";
    const completedAt = "2026-06-09T10:01:01Z";
    const completedAtLabel = new Date(completedAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const sentMessages: {
      prompt?: string;
      revokesEventId?: string;
      userMessage?: unknown;
    }[] = [];

    mockChatLifecycle(context, {
      threadId: FOLLOWUP_THREAD_ID,
      threadTitle: "Launch package",
      chatEvents: [
        {
          id: "msg-followup-user",
          eventType: "input.prompt" as const,
          role: "user",
          content: "Package this launch plan",
          runId: "run-followup",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-assistant",
          eventType: "output.message" as const,
          role: "assistant",
          content: assistantReply,
          runId: "run-followup",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-followup-completed",
          eventType: "run.completed" as const,
          role: "assistant",
          content: null,
          runId: "run-followup",
          runLifecycleEvent: "completed",
          followups: [
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
    });

    const composer = await findWorkflowComposerEditor();
    await fill(composer, existingDraft);
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
      expect(composer.textContent).toBe(`${existingDraft}\n${followupPrompt}`);
      expect(buttonByText(followupPrompt)).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
    expect(sentMessages).toHaveLength(0);

    click(buttonByText(followupPrompt));

    await waitFor(() => {
      expect(composer).toHaveFocus();
      expect(window.getSelection()?.toString()).toBe(followupPrompt);
    });
    expect(composer.textContent).toBe(`${existingDraft}\n${followupPrompt}`);
    expect(sentMessages).toHaveLength(0);
  });

  it("preserves follow-up content and selection when the card rail is enabled", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000734";
    const prompts = [
      "Draft launch copy",
      "Create a detailed presentation outline with speaker notes",
      "Generate a hero image",
    ];
    const completedAt = "2026-06-09T10:01:01Z";
    const completedAtLabel = new Date(completedAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const selectedPrompt = prompts[1]!;
    const sentMessages: unknown[] = [];

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Responsive follow-ups",
      chatEvents: [
        {
          id: "msg-responsive-followups-assistant",
          eventType: "output.message",
          role: "assistant",
          content: "The launch plan is ready.",
          runId: "run-responsive-followups",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-responsive-followups-completed",
          eventType: "run.completed",
          role: "assistant",
          content: null,
          runId: "run-responsive-followups",
          runLifecycleEvent: "completed",
          followups: prompts.map((prompt) => {
            return { prompt, kind: "talk" as const };
          }),
          createdAt: completedAt,
        },
      ],
      onRunCreate: (body) => {
        sentMessages.push(body);
      },
    });

    // The card rail is a mobile-only surface: the same coarse-pointer
    // heuristic that gates the composer's auto-focus device decides it.
    context.mocks.browser.matchMedia((query) => {
      return query === "(pointer: coarse)";
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ResponsiveFollowupCards]: true,
      },
    });

    const composer = await findWorkflowComposerEditor();
    await screen.findByText("The launch plan is ready.");
    expect(
      screen.getByText(`Keep going · ${completedAtLabel}`),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Keep going" }),
    ).toBeInTheDocument();
    for (const prompt of prompts) {
      const card = buttonByText(prompt);
      expect(card).toBeVisible();
      expect(card).toHaveAccessibleName(prompt);
    }

    click(buttonByText(selectedPrompt));

    await waitFor(() => {
      expect(composer.textContent).toBe(selectedPrompt);
      expect(composer).toHaveFocus();
    });
    expect(sentMessages).toHaveLength(0);
  });

  it("keeps the flat list on desktop even with a narrow window", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000735";
    const prompts = ["Draft launch copy", "Generate a hero image"];
    const completedAt = "2026-06-09T10:01:01Z";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Narrow desktop window",
      chatEvents: [
        {
          id: "msg-narrow-desktop-assistant",
          eventType: "output.message",
          role: "assistant",
          content: "The launch plan is ready.",
          runId: "run-narrow-desktop",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-narrow-desktop-completed",
          eventType: "run.completed",
          role: "assistant",
          content: null,
          runId: "run-narrow-desktop",
          runLifecycleEvent: "completed",
          followups: prompts.map((prompt) => {
            return { prompt, kind: "talk" as const };
          }),
          createdAt: completedAt,
        },
      ],
    });

    // Fine-pointer desktop: even a dragged-narrow window must not produce
    // cards, matching the composer auto-focus heuristic.
    context.mocks.browser.matchMedia((query) => {
      return query === "(any-pointer: fine)";
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ResponsiveFollowupCards]: true,
      },
    });

    await screen.findByText("The launch plan is ready.");
    const group = screen.getByRole("group", { name: "Keep going" });
    for (const prompt of prompts) {
      expect(buttonByText(prompt)).toBeInTheDocument();
    }
    // No horizontal card rail on desktop: the buttons stay full-width rows
    // (w-full, items-center) rather than fixed-width self-stretch cards.
    const rows = Array.from(group.querySelectorAll<HTMLElement>("button"));
    expect(rows).toHaveLength(prompts.length);
    expect(rows[0]?.className).toContain("w-full");
    expect(rows[0]?.className).not.toContain("flex-[0_0_min");
  });

  it("shows recommended follow-ups after an appended follow-up event", async () => {
    const assistantReply = "I can turn this into a launch package.";
    const followupPrompt = "Create a presentation outline";
    const completedMarker: MockChatEventInput = {
      id: "00000000-0000-4000-8000-000000004001",
      eventType: "run.completed" as const,
      role: "assistant",
      content: null,
      runId: "run-followup",
      runLifecycleEvent: "completed",
      seqId: 3,
      createdAt: "2026-06-09T10:01:01Z",
    };
    const followupsEvent: MockChatEventInput = {
      id: "00000000-0000-4000-8000-000000004002",
      eventType: "output.followups",
      role: "assistant",
      content: null,
      runId: "run-followup",
      followups: [
        {
          prompt: followupPrompt,
          kind: "generate",
          generationType: "presentation",
        },
      ],
      seqId: 4,
      createdAt: "2026-06-09T10:01:02Z",
    };
    const chatEvents: MockChatEventInput[] = [
      {
        id: "msg-followup-user",
        eventType: "input.prompt" as const,
        role: "user",
        content: "Package this launch plan",
        runId: "run-followup",
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        id: "msg-followup-assistant",
        eventType: "output.message" as const,
        role: "assistant",
        content: assistantReply,
        runId: "run-followup",
        sequenceNumber: 2,
        createdAt: "2026-06-09T10:01:01Z",
      },
      completedMarker,
    ];

    mockChatLifecycle(context, {
      threadId: FOLLOWUP_THREAD_ID,
      threadTitle: "Launch package",
      chatEvents,
    });

    detachedSetupPage({
      context,
      path: `/chats/${FOLLOWUP_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
      expect(queryButtonByText(followupPrompt)).not.toBeInTheDocument();
    });

    chatEvents.push(followupsEvent);
    createChatEvent(FOLLOWUP_THREAD_ID, {});

    await waitFor(() => {
      expect(buttonByText(followupPrompt)).toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("renders strict version-1 follow-up content", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000732";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-followup-wire-assistant",
          eventType: "output.message",
          role: "assistant",
          content: "The launch plan is ready.",
          runId: "run-followup-wire",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-wire-shape",
          eventType: "output.followups",
          role: "assistant",
          runId: "run-followup-wire",
          seqId: 2,
          createdAt: "2026-06-09T10:00:01Z",
          content: JSON.stringify({
            version: 1,
            followups: [
              {
                prompt: "Prepare the launch checklist",
                kind: "talk",
              },
            ],
          }),
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(buttonByText("Prepare the launch checklist")).toBeInTheDocument();
    });
  });

  it("ignores invalid follow-up content without rendering its JSON", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000733";
    const invalidContent = JSON.stringify({
      version: 2,
      followups: [{ prompt: "Unsafe raw follow-up", kind: "talk" }],
    });
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-invalid-followup-content",
          eventType: "output.followups",
          role: "assistant",
          content: invalidContent,
          runId: "run-invalid-followup-content",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
    expect(queryButtonByText("Unsafe raw follow-up")).not.toBeInTheDocument();
    expect(screen.queryByText(invalidContent)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unsafe raw follow-up/u)).not.toBeInTheDocument();
  });

  it("catches recommended follow-ups written before realtime subscription is ready", async () => {
    const assistantReply = "I can turn this into a launch package.";
    const followupPrompt = "Create a presentation outline";
    const completedMarker: MockChatEventInput = {
      id: "00000000-0000-4000-8000-000000004003",
      eventType: "run.completed" as const,
      role: "assistant",
      content: null,
      runId: "run-followup-subscribe-gap",
      runLifecycleEvent: "completed",
      seqId: 3,
      createdAt: "2026-06-09T10:01:01Z",
    };
    const followupsEvent: MockChatEventInput = {
      id: "00000000-0000-4000-8000-000000004004",
      eventType: "output.followups",
      role: "assistant",
      content: null,
      runId: "run-followup-subscribe-gap",
      followups: [
        {
          prompt: followupPrompt,
          kind: "generate",
          generationType: "presentation",
        },
      ],
      seqId: 4,
      createdAt: "2026-06-09T10:01:02Z",
    };
    const chatEvents: MockChatEventInput[] = [
      {
        id: "msg-followup-subscribe-gap-user",
        eventType: "input.prompt" as const,
        role: "user",
        content: "Package this launch plan",
        runId: "run-followup-subscribe-gap",
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        id: "msg-followup-subscribe-gap-assistant",
        eventType: "output.message" as const,
        role: "assistant",
        content: assistantReply,
        runId: "run-followup-subscribe-gap",
        createdAt: "2026-06-09T10:01:00Z",
      },
      completedMarker,
    ];
    let updatedAfterInitialList = false;

    mockChatLifecycle(context, {
      threadId: FOLLOWUP_THREAD_ID,
      threadTitle: "Launch package",
      chatEvents,
      afterInitialEventsList: () => {
        if (updatedAfterInitialList) {
          return;
        }
        updatedAfterInitialList = true;
        chatEvents.push(followupsEvent);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FOLLOWUP_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(buttonByText(followupPrompt)).toBeInTheDocument();
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
      chatEvents: [
        {
          id: queuedMessageId,
          eventType: "input.prompt" as const,
          role: "user",
          content: prompt,
          runId: undefined,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: claimedMessageId,
          eventType: "input.prompt" as const,
          role: "user",
          content: prompt,
          runId,
          revokesEventId: queuedMessageId,
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
      chatEvents: [
        {
          id: "msg-followup-old-user",
          eventType: "input.prompt" as const,
          role: "user",
          content: "Package this launch plan",
          runId: "run-followup-old",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-old-assistant",
          eventType: "output.message" as const,
          role: "assistant",
          content: firstAssistantReply,
          runId: "run-followup-old",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-followup-old-completed",
          eventType: "run.completed" as const,
          role: "assistant",
          content: null,
          runId: "run-followup-old",
          runLifecycleEvent: "completed",
          followups: [
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
          eventType: "input.prompt" as const,
          role: "user",
          content: followupPrompt,
          runId: "run-followup-new",
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-followup-new-assistant",
          eventType: "output.message" as const,
          role: "assistant",
          content: newerAssistantReply,
          runId: "run-followup-new",
          createdAt: "2026-06-09T10:03:00Z",
        },
        {
          id: "msg-followup-new-completed",
          eventType: "run.completed" as const,
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
