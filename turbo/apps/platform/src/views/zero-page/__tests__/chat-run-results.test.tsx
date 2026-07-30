import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  chatEventResponse,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadEventsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { click } from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { mockChatLifecycle, mockSubagentThread } from "./chat-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  SERVER_QUEUED_RUN_THREAD_ID,
  expectTextBefore,
  makeEvent,
  mockServerQueuedThreadStories,
  buttonByText,
  buttonByLabel,
} from "./chat-lifecycle-test-helpers.ts";

afterEach(async () => {
  document.documentElement.lang = DEFAULT_LOCALE;
  await initializeI18n(DEFAULT_LOCALE);
});

describe("chat lifecycle", () => {
  it("shows run credit usage with friendly popover details", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip",
      chatEvents: [
        {
          id: "msg-usage-chip-user",
          role: "user",
          content: "Summarize usage",
          runId: "run-usage-chip",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-chip-assistant",
          role: "assistant",
          content: "Usage summary is ready.",
          runId: "run-usage-chip",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-chip",
          role: "assistant",
          content: null,
          runId: "run-usage-chip",
          usage: {
            version: 1,
            totalCredits: 24_734,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model/kimi-k2.5/tokens.input",
                credits: 234,
                providers: [{ provider: "moonshot", credits: 234 }],
              },
              {
                kind: "model/kimi-k2.5/tokens.output",
                credits: 1000,
                providers: [{ provider: "moonshot", credits: 1000 }],
              },
              {
                kind: "model/vm0-model/tokens.output",
                credits: 500,
                providers: [{ provider: "vm0-model", credits: 500 }],
              },
              {
                kind: "image",
                credits: 23_000,
                providers: [{ provider: "gpt-image-2", credits: 23_000 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip",
    });

    const credit = await waitFor(() => {
      return buttonByLabel("Credit usage 24,734");
    });
    const actions = credit.closest('[data-testid="chat-event-actions"]');
    expect(actions).not.toBeNull();
    const copy = within(actions as HTMLElement).getByLabelText("Copy message");
    expect(
      copy.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    click(credit);

    await waitFor(() => {
      expect(screen.getAllByText("Credit usage").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("24,734").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Kimi K2.5").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("1,234").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Auto").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("GPT Image 2").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("23,000").length).toBeGreaterThanOrEqual(1);
      expect(
        screen.queryByText("model/kimi-k2.5/tokens.input"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("moonshot")).not.toBeInTheDocument();
    });

    click(credit);

    await waitFor(() => {
      expect(screen.queryByText("Credit usage")).not.toBeInTheDocument();
    });

    click(credit);

    await waitFor(() => {
      expect(screen.getAllByText("Credit usage").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("Kimi K2.5").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("1,234").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows generation usage with model names only", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-generation-usage-model-names",
      chatEvents: [
        {
          id: "msg-generation-usage-user",
          role: "user",
          content: "Generate image and video usage",
          runId: "run-generation-usage",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-generation-usage-assistant",
          role: "assistant",
          content: "Generated media is ready.",
          runId: "run-generation-usage",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-generation-usage",
          role: "assistant",
          content: null,
          runId: "run-generation-usage",
          usage: {
            version: 1,
            totalCredits: 1976,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "image",
                credits: 96,
                providers: [{ provider: "fal-ai/nano-banana-2", credits: 96 }],
              },
              {
                kind: "video",
                credits: 1880,
                providers: [
                  {
                    provider: "dreamina-seedance-2-0-260128",
                    credits: 1880,
                  },
                ],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-generation-usage-model-names",
    });

    const credit = await screen.findByLabelText("Credit usage 1,976");
    click(credit);

    await waitFor(() => {
      expect(screen.getAllByText("Credit usage").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        screen.getAllByText("Nano Banana 2").length,
      ).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("96").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Seedance 2.0").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("1,880").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText(/fal\.? ?ai/iu)).not.toBeInTheDocument();
      expect(screen.queryByText(/dreamina/iu)).not.toBeInTheDocument();
    });
  });

  it("shows the latest immutable run usage settlement", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip-settlements",
      chatEvents: [
        {
          id: "msg-usage-settlement-user",
          role: "user",
          content: "Summarize usage settlements",
          runId: "run-usage-settlement",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-settlement-assistant",
          role: "assistant",
          content: "Usage summary is ready.",
          runId: "run-usage-settlement",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-settlement-first",
          role: "assistant",
          content: null,
          runId: "run-usage-settlement",
          usage: {
            version: 1,
            totalCredits: 12,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model/gpt-5.5/tokens.output",
                credits: 12,
                providers: [{ provider: "openai", credits: 12 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-usage-settlement-second",
          role: "assistant",
          content: null,
          runId: "run-usage-settlement",
          usage: {
            version: 1,
            totalCredits: 108,
            settledAt: "2026-06-09T10:00:05Z",
            breakdown: [
              {
                kind: "model/gpt-5.5/tokens.output",
                credits: 12,
                providers: [{ provider: "openai", credits: 12 }],
              },
              {
                kind: "image",
                credits: 96,
                providers: [{ provider: "nano-banana-2", credits: 96 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip-settlements",
    });

    await expect(
      screen.findByLabelText("Credit usage 108"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Credit usage 12")).not.toBeInTheDocument();
  });

  it("keeps managed API usage visible when completed work is folded", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip-folded-managed-api",
      chatEvents: [
        {
          id: "msg-usage-folded-user",
          role: "user",
          content: "Use the managed APIs",
          runId: "run-usage-folded-managed-api",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-folded-work",
          role: "assistant",
          content: "Inspecting managed API results.",
          runId: "run-usage-folded-managed-api",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-folded-final",
          role: "assistant",
          content: "Managed API usage is ready.",
          runId: "run-usage-folded-managed-api",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-usage-folded-usage",
          role: "assistant",
          content: null,
          runId: "run-usage-folded-managed-api",
          usage: {
            version: 1,
            totalCredits: 216,
            settledAt: "2026-06-09T10:00:03Z",
            breakdown: [
              {
                kind: "scrape",
                credits: 36,
                providers: [{ provider: "firecrawl", credits: 36 }],
              },
              {
                kind: "maps",
                credits: 36,
                providers: [{ provider: "google-maps", credits: 36 }],
              },
              {
                kind: "web-search",
                credits: 36,
                providers: [{ provider: "perplexity", credits: 36 }],
              },
              {
                kind: "people-search",
                credits: 36,
                providers: [{ provider: "perplexity", credits: 36 }],
              },
              {
                kind: "finance",
                credits: 36,
                providers: [{ provider: "apidojo", credits: 36 }],
              },
              {
                kind: "weather",
                credits: 36,
                providers: [{ provider: "google-weather", credits: 36 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-usage-folded-completed",
          role: "assistant",
          content: null,
          runId: "run-usage-folded-managed-api",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:04Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip-folded-managed-api",
    });

    await expect(
      screen.findByText("Managed API usage is ready."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Inspecting managed API results."),
    ).not.toBeInTheDocument();

    const managedApiCredit = await screen.findByLabelText("Credit usage 216");
    click(managedApiCredit);

    await waitFor(() => {
      expect(screen.getByText("Web Fetch")).toBeInTheDocument();
      expect(screen.getByText("Maps")).toBeInTheDocument();
      expect(screen.getByText("Web Search")).toBeInTheDocument();
      expect(screen.getByText("People Search")).toBeInTheDocument();
      expect(screen.getByText("Finance")).toBeInTheDocument();
      expect(screen.getByText("Weather")).toBeInTheDocument();
      expect(screen.getAllByText("36")).toHaveLength(6);
      expect(screen.queryByText("Firecrawl")).not.toBeInTheDocument();
      expect(screen.queryByText("Google Maps")).not.toBeInTheDocument();
      expect(screen.queryByText("Perplexity")).not.toBeInTheDocument();
      expect(screen.queryByText("Apidojo")).not.toBeInTheDocument();
      expect(screen.queryByText("Google Weather")).not.toBeInTheDocument();
    });
  });

  it("keeps connector usage attached to consecutive assistant runs", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip-consecutive-runs",
      chatEvents: [
        {
          id: "msg-usage-consecutive-user",
          role: "user",
          content: "Summarize two runs",
          runId: "run-usage-model",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-consecutive-model-assistant",
          role: "assistant",
          content: "Model usage is ready.",
          runId: "run-usage-model",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-consecutive-model",
          role: "assistant",
          content: null,
          runId: "run-usage-model",
          usage: {
            version: 1,
            totalCredits: 12,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model/gpt-5.5/tokens.output",
                credits: 12,
                providers: [{ provider: "openai", credits: 12 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-usage-consecutive-model-completed",
          role: "assistant",
          content: null,
          runId: "run-usage-model",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-usage-consecutive-connector-assistant",
          role: "assistant",
          content: "Connector usage is ready.",
          runId: "run-usage-connector",
          createdAt: "2026-06-09T10:00:04Z",
        },
        {
          id: "msg-usage-consecutive-connector",
          role: "assistant",
          content: null,
          runId: "run-usage-connector",
          usage: {
            version: 1,
            totalCredits: 108,
            settledAt: "2026-06-09T10:00:05Z",
            breakdown: [
              {
                kind: "connector",
                credits: 108,
                providers: [{ provider: "x", credits: 108 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:05Z",
        },
        {
          id: "msg-usage-consecutive-connector-completed",
          role: "assistant",
          content: null,
          runId: "run-usage-connector",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:06Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip-consecutive-runs",
    });

    await expect(
      screen.findByLabelText("Credit usage 12"),
    ).resolves.toBeInTheDocument();
    const connectorCredit = await screen.findByLabelText("Credit usage 108");

    click(connectorCredit);

    await waitFor(() => {
      expect(screen.getByText("Connector usage is ready.")).toBeInTheDocument();
      expect(screen.getAllByText("X").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("108").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("stops a server-queued run and recalls queued follow-up messages", async () => {
    const interrupts: string[] = [];
    const recalls: string[] = [];
    mockChatLifecycle(context, {
      threadId: SERVER_QUEUED_RUN_THREAD_ID,
      chatEvents: [
        {
          id: "msg-server-queued-user",
          role: "user",
          content: "Start the server queued run",
          runId: "run-server-queued",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-server-queue-marker",
          role: "assistant",
          content: null,
          runId: "run-server-queued",
          runEventId: "queue:queued",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-server-queued-followup",
          role: "user",
          content: "Follow up when the queued run starts",
          runId: undefined,
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      onInterruptEventAppend: (body) => {
        interrupts.push(body.interruptsRunId);
      },
      onRecallEventAppend: (body) => {
        recalls.push(body.revokesEventId);
      },
      activeRunIds: ["run-server-queued"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${SERVER_QUEUED_RUN_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Start the server queued run"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Follow up when the queued run starts"),
      ).toBeInTheDocument();
      expect(screen.getByText("1 message waiting")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Stop"));

    await waitFor(() => {
      expect(interrupts).toContain("run-server-queued");
      expect(recalls).toContain("msg-server-queued-followup");
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it("shows server queue state only while the queue marker is unresolved", async () => {
    mockServerQueuedThreadStories();

    detachedSetupPage({
      context,
      path: "/chats/b0000000-0000-4000-a000-000000000710",
    });

    await waitFor(() => {
      expect(screen.getByText("Start queued deployment")).toBeInTheDocument();
      expect(screen.getByText("queue...")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    click(screen.getByText("Resolved server queue"));

    await waitFor(() => {
      expect(
        screen.getByText("Queued deployment is running now."),
      ).toBeInTheDocument();
      expect(screen.queryByText("queue...")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it("keeps chat work visible while the run is active", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-running",
      activeRunIds: ["run-work-folding-running"],
      chatEvents: [
        {
          role: "user",
          content: "Draft the launch checklist",
          runId: "run-work-folding-running",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking the remaining launch steps.",
          runId: "run-work-folding-running",
          createdAt: "2026-06-09T10:00:20Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-running",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Draft the launch checklist"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Checking the remaining launch steps."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("keeps completed chat work folded while a later run is active", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-completed-before-active",
      activeRunIds: ["run-work-folding-active-later"],
      chatEvents: [
        {
          role: "user",
          content: "Summarize the earlier launch",
          runId: "run-work-folding-completed-before-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking the earlier launch notes.",
          runId: "run-work-folding-completed-before-active",
          createdAt: "2026-06-09T10:00:10Z",
        },
        {
          role: "assistant",
          content: "The earlier launch summary is ready.",
          runId: "run-work-folding-completed-before-active",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "user",
          content: "Investigate the current launch",
          runId: "run-work-folding-active-later",
          createdAt: "2026-06-09T10:05:00Z",
        },
        {
          role: "assistant",
          content: "Checking the current launch notes.",
          runId: "run-work-folding-active-later",
          createdAt: "2026-06-09T10:05:10Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-completed-before-active",
    });

    const expandButtons = await screen.findAllByLabelText(
      "Expand work history",
    );
    expect(expandButtons).toHaveLength(1);
    expect(expandButtons[0]).toHaveTextContent("Worked for 20s");
    expect(
      screen.getByText("Summarize the earlier launch"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking the earlier launch notes.")).toBeNull();
    expect(
      screen.getByText("The earlier launch summary is ready."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Investigate the current launch"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Checking the current launch notes."),
    ).toBeInTheDocument();
  });

  it("folds completed chat work and toggles the hidden history", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-completed",
      chatEvents: [
        {
          role: "user",
          content: "Summarize the launch status",
          runId: "run-work-folding-completed",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking launch status.",
          runId: "run-work-folding-completed",
          createdAt: "2026-06-09T10:00:25Z",
        },
        {
          role: "assistant",
          content: "Launch status is summarized.",
          runId: "run-work-folding-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:55Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-completed",
    });

    const expandButton = await screen.findByLabelText("Expand work history");
    expect(expandButton).toHaveTextContent("Worked for 55s");
    expect(expandButton.querySelectorAll('[aria-hidden="true"]')).toHaveLength(
      2,
    );
    const foldedAssistantGroup = expandButton.closest(
      '[data-role="assistant"]',
    ) as HTMLElement | null;
    expect(foldedAssistantGroup).not.toBeNull();
    expect(foldedAssistantGroup).not.toHaveClass("group");
    expect(
      within(foldedAssistantGroup!).getAllByLabelText("View agent profile"),
    ).toHaveLength(1);
    expect(screen.getByText("Summarize the launch status")).toBeInTheDocument();
    expect(screen.queryByText("Checking launch status.")).toBeNull();
    expect(
      screen.getByText("Launch status is summarized."),
    ).toBeInTheDocument();

    click(expandButton);

    await waitFor(() => {
      expect(
        within(foldedAssistantGroup!).getByText("Checking launch status."),
      ).toBeInTheDocument();
      expect(
        within(foldedAssistantGroup!).getAllByLabelText("View agent profile"),
      ).toHaveLength(1);
      expectTextBefore(
        foldedAssistantGroup!,
        "Worked for 55s",
        "Checking launch status.",
      );
      expectTextBefore(
        foldedAssistantGroup!,
        "Checking launch status.",
        "Launch status is summarized.",
      );
      expect(screen.getByLabelText("Collapse work history")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    click(screen.getByLabelText("Collapse work history"));

    await waitFor(() => {
      expect(
        screen.getByText("Summarize the launch status"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Checking launch status.")).toBeNull();
      expect(screen.getByLabelText("Expand work history")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
  });

  it("keeps the established completed-run layout across container sizes", async () => {
    const finalReply = "The launch plan is ready.";
    const followupPrompt = "Turn it into a presentation";
    const completedAt = "2026-06-09T10:00:21Z";
    const completedAtLabel = new Date(completedAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

    mockChatLifecycle(context, {
      threadId: "thread-completed-run-layout",
      chatEvents: [
        {
          role: "user",
          content: "Prepare the launch plan",
          runId: "run-completed-run-layout",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Reviewing the launch notes.",
          runId: "run-completed-run-layout",
          createdAt: "2026-06-09T10:00:10Z",
        },
        {
          role: "assistant",
          content: finalReply,
          runId: "run-completed-run-layout",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-completed-run-layout",
          runLifecycleEvent: "completed",
          createdAt: completedAt,
        },
        {
          role: "assistant",
          content: null,
          runId: "run-completed-run-layout",
          recommendedFollowups: [
            {
              prompt: followupPrompt,
              kind: "generate",
              generationType: "presentation",
            },
          ],
          createdAt: "2026-06-09T10:00:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-completed-run-layout",
    });

    const expandButton = await screen.findByLabelText("Expand work history");
    const finalReplyElement = await screen.findByText(finalReply);
    const assistantGroup = finalReplyElement.closest('[data-role="assistant"]');
    expect(assistantGroup).not.toBeNull();

    const responseLayout = assistantGroup!.firstElementChild;
    expect(responseLayout).toHaveClass(
      "flex",
      "flex-col",
      "gap-2",
      "@[900px]:grid",
      "@[900px]:grid-cols-[36px_minmax(0,1fr)]",
      "@[900px]:-ml-[46px]",
    );
    expect(responseLayout).not.toHaveClass(
      "grid",
      "grid-cols-[28px_minmax(0,1fr)]",
    );

    const responseColumn = responseLayout!.children[1];
    expect(responseColumn).toHaveClass("relative", "flex", "flex-col", "gap-2");
    expect(responseColumn).not.toHaveClass("contents");
    expect(responseColumn).toContainElement(finalReplyElement);

    const completedWorkFold = expandButton.parentElement;
    expect(completedWorkFold).toHaveAttribute("data-chat-completed-work-fold");
    expect(completedWorkFold).toHaveClass("-mx-2", "@[900px]:-mb-[15px]");
    expect(completedWorkFold).not.toHaveClass("border-b", "pb-2");
    expect(responseColumn).toContainElement(completedWorkFold);
    expect(expandButton).toHaveClass(
      "mt-1.5",
      "min-h-9",
      "gap-2",
      "px-2",
      "py-1.5",
    );
    expect(expandButton).not.toHaveClass("max-w-full");

    const followupButton = await waitFor(() => {
      return buttonByText(followupPrompt);
    });
    const followupList = followupButton.parentElement;
    expect(followupList).toHaveClass("-mx-2");
    expect(followupList).not.toHaveClass("flex", "gap-1");
    expect(followupButton).not.toHaveClass("border", "bg-background");

    const finishedLabel = screen.getByText(`Keep going · ${completedAtLabel}`);
    const finishedLabelRow = finishedLabel.parentElement;
    const finishedDivider = finishedLabelRow!.parentElement;
    const finishedRunRow = finishedDivider!.parentElement;
    expect(finishedRunRow).toHaveClass("flex", "flex-col", "gap-2");
    expect(finishedRunRow).not.toHaveClass(
      "rounded-[var(--zero-card-radius)]",
      "bg-gray-50",
      "p-3",
    );
    expect(followupList!.parentElement).toBe(finishedRunRow);
    expect(finishedDivider!.firstElementChild).toHaveClass(
      "h-px",
      "w-full",
      "bg-border/40",
    );
    expect(finishedDivider!.firstElementChild).not.toHaveClass("hidden");
    expect(finishedLabelRow!.lastElementChild).toHaveClass(
      "h-px",
      "flex-1",
      "bg-border/40",
    );
    expect(finishedLabelRow!.lastElementChild).not.toHaveClass("hidden");
  });

  it("formats completed-run timestamps with the selected Portuguese locale", async () => {
    const completedAt = "2026-06-09T10:00:21Z";
    const completedAtLabel = new Date(completedAt).toLocaleString("pt-BR", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    mockChatLifecycle(context, {
      threadId: "thread-localized-completed-run",
      chatEvents: [
        {
          role: "user",
          content: "Prepare o plano de lançamento",
          runId: "run-localized-completed-run",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "O plano de lançamento está pronto.",
          runId: "run-localized-completed-run",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-localized-completed-run",
          runLifecycleEvent: "completed",
          createdAt: completedAt,
        },
        {
          role: "assistant",
          content: null,
          runId: "run-localized-completed-run",
          recommendedFollowups: [
            {
              prompt: "Transforme em uma apresentação",
              kind: "generate",
              generationType: "presentation",
            },
          ],
          createdAt: "2026-06-09T10:00:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-localized-completed-run",
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
    });

    await expect(
      screen.findByText(`Continuar · ${completedAtLabel}`),
    ).resolves.toBeInTheDocument();
    expect(document.documentElement.lang).toBe("pt-BR");
  });

  it("does not let an attached lifecycle marker hide the final answer", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-completion-marker",
      chatEvents: [
        {
          role: "user",
          content: "Summarize the production launch status",
          runId: "run-work-folding-completion-marker",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking production launch status.",
          runId: "run-work-folding-completion-marker",
          createdAt: "2026-06-09T10:00:25Z",
        },
        {
          role: "assistant",
          content: "The production launch status is ready.",
          runId: "run-work-folding-completion-marker",
          createdAt: "2026-06-09T10:00:55Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-work-folding-completion-marker",
          runLifecycleEvent: "completed",
          attachFiles: [
            {
              id: "legacy-completion-attachment",
              filename: "launch-status.pdf",
              contentType: "application/pdf",
              size: 4096,
              url: "https://example.com/launch-status.pdf",
            },
          ],
          createdAt: "2026-06-09T10:00:56Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-completion-marker",
    });

    const expandButton = await screen.findByLabelText("Expand work history");
    expect(expandButton).toHaveTextContent("Worked for 56s");
    expect(
      screen.getByText("Summarize the production launch status"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking production launch status.")).toBeNull();
    expect(
      screen.getByText("The production launch status is ready."),
    ).toBeInTheDocument();

    click(expandButton);

    await waitFor(() => {
      expect(
        screen.getByText("Checking production launch status."),
      ).toBeInTheDocument();
      expect(
        screen.getByText("The production launch status is ready."),
      ).toBeInTheDocument();
    });
  });

  it("folds each completed run independently", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-each-run",
      chatEvents: [
        {
          role: "user",
          content: "Summarize the first launch",
          runId: "run-work-folding-first",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking the first launch notes.",
          runId: "run-work-folding-first",
          createdAt: "2026-06-09T10:00:10Z",
        },
        {
          role: "assistant",
          content: "The first launch summary is ready.",
          runId: "run-work-folding-first",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "user",
          content: "Summarize the second launch",
          runId: "run-work-folding-second",
          createdAt: "2026-06-09T10:05:00Z",
        },
        {
          role: "assistant",
          content: "Checking the second launch notes.",
          runId: "run-work-folding-second",
          createdAt: "2026-06-09T10:05:25Z",
        },
        {
          role: "assistant",
          content: "The second launch summary is ready.",
          runId: "run-work-folding-second",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:05:55Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-each-run",
    });

    const expandButtons = await screen.findAllByLabelText(
      "Expand work history",
    );
    expect(expandButtons).toHaveLength(2);
    expect(expandButtons[0]).toHaveTextContent("Worked for 20s");
    expect(expandButtons[1]).toHaveTextContent("Worked for 55s");
    const secondAssistantGroup = expandButtons[1]!.closest(
      '[data-role="assistant"]',
    ) as HTMLElement | null;
    expect(secondAssistantGroup).not.toBeNull();
    expect(screen.getByText("Summarize the first launch")).toBeInTheDocument();
    expect(screen.queryByText("Checking the first launch notes.")).toBeNull();
    expect(
      screen.getByText("The first launch summary is ready."),
    ).toBeInTheDocument();
    expect(screen.getByText("Summarize the second launch")).toBeInTheDocument();
    expect(screen.queryByText("Checking the second launch notes.")).toBeNull();
    expect(
      screen.getByText("The second launch summary is ready."),
    ).toBeInTheDocument();

    click(expandButtons[1]!);

    await waitFor(() => {
      expect(
        screen.getByText("Summarize the first launch"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Checking the first launch notes.")).toBeNull();
      expect(
        screen.getByText("Summarize the second launch"),
      ).toBeInTheDocument();
      expect(
        within(secondAssistantGroup!).getByText(
          "Checking the second launch notes.",
        ),
      ).toBeInTheDocument();
      expect(
        within(secondAssistantGroup!).getAllByLabelText("View agent profile"),
      ).toHaveLength(1);
      expectTextBefore(
        secondAssistantGroup!,
        "Worked for 55s",
        "Checking the second launch notes.",
      );
      expectTextBefore(
        secondAssistantGroup!,
        "Checking the second launch notes.",
        "The second launch summary is ready.",
      );
      expect(screen.getByLabelText("Collapse work history")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
  });

  it("keeps chat work visible when the run was cancelled", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-cancelled",
      chatEvents: [
        {
          role: "user",
          content: "Summarize the launch status",
          runId: "run-work-folding-cancelled",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking launch status.",
          runId: "run-work-folding-cancelled",
          createdAt: "2026-06-09T10:00:25Z",
        },
        {
          role: "assistant",
          content: "Run cancelled",
          error: "Run cancelled",
          runId: "run-work-folding-cancelled",
          runLifecycleEvent: "cancelled",
          createdAt: "2026-06-09T10:00:55Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-cancelled",
    });

    await waitFor(() => {
      expect(screen.getByText("Checking launch status.")).toBeInTheDocument();
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Expand work history")).toBeNull();
  });

  it("does not fold a completed run with only a user message and final reply", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-user-final-only",
      chatEvents: [
        {
          role: "user",
          content: "Answer directly",
          runId: "run-work-folding-user-final-only",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Direct answer.",
          runId: "run-work-folding-user-final-only",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-user-final-only",
    });

    await waitFor(() => {
      expect(screen.getByText("Answer directly")).toBeInTheDocument();
      expect(screen.getByText("Direct answer.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("does not fold a completed run when the only prior assistant message is thinking", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-thinking-only",
      chatEvents: [
        {
          role: "user",
          content: "Summarize the launch status",
          runId: "run-work-folding-thinking-only",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          thinking: "Reviewing launch context",
          runId: "run-work-folding-thinking-only",
          createdAt: "2026-06-09T10:00:05Z",
        },
        {
          role: "assistant",
          content: "Launch status is ready.",
          runId: "run-work-folding-thinking-only",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-thinking-only",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Summarize the launch status"),
      ).toBeInTheDocument();
      expect(screen.getByText("Launch status is ready.")).toBeInTheDocument();
      expect(screen.queryByText("Worked for 5s")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("does not fold a completed run with a single message", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-single-message",
      chatEvents: [
        {
          role: "assistant",
          content: "Standalone run result.",
          runId: "run-work-folding-single",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-single-message",
    });

    await waitFor(() => {
      expect(screen.getByText("Standalone run result.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("renders a server-corrected assistant message without the stale answer", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-corrected-answer",
      threadTitle: "Corrected answer",
      chatEvents: [
        {
          id: "msg-corrected-user",
          role: "user",
          content: "Summarize the launch plan",
          runId: "run-corrected-answer",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-stale-answer",
          role: "assistant",
          content: "Use the old launch plan.",
          runId: "run-corrected-answer",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-new-answer",
          role: "assistant",
          content: "Use the revised launch plan with updated owners.",
          runId: "run-corrected-answer",
          revokesEventId: "msg-stale-answer",
          createdAt: "2026-06-09T10:02:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-corrected-answer",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Use the revised launch plan with updated owners."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Use the old launch plan."),
      ).not.toBeInTheDocument();
    });
  });

  it("restores an interrupted run without duplicate cancellation rows", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-restored-interrupt",
      threadTitle: "Restored interrupt",
      chatEvents: [
        {
          id: "msg-interrupted-user",
          role: "user",
          content: "Start a long task",
          runId: "run-restored-interrupt",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-interrupted-assistant",
          role: "assistant",
          content: null,
          runId: "run-restored-interrupt",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-interrupt-control",
          role: "user",
          content: null,
          interruptsRunId: "run-restored-interrupt",
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-server-cancelled",
          role: "assistant",
          content: "Run cancelled",
          runId: "run-restored-interrupt",
          error: "Run cancelled",
          runLifecycleEvent: "cancelled",
          createdAt: "2026-06-09T10:03:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-restored-interrupt",
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("Paused mid-thought — pick it back up whenever."),
      ).toHaveLength(1);
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it("catches up after a missed realtime burst on reconnect", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000748";
    const baselineMessages = Array.from({ length: 5 }, (_, index) => {
      return {
        ...makeEvent(`base-${index}`, `Baseline ${index}`, threadId),
        seqId: index + 1,
      };
    });
    const burstMessages = Array.from({ length: 120 }, (_, index) => {
      return {
        ...makeEvent(`burst-${index}`, `Burst ${index}`, threadId),
        seqId: baselineMessages.length + index + 1,
      };
    });
    const finalPageGate = context.mocks.deferred<void>();
    let burstEnabled = false;
    let page = 0;
    let finalForwardPageRequested = false;
    const sinceSeqIds: number[] = [];

    mockSubagentThread(context, threadId);
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(
      chatThreadEventsContract.list,
      async ({ query, respond }) => {
        if (!query.sinceSeqId) {
          return respond(200, {
            events: baselineMessages.map(chatEventResponse),
            hasHistoryBefore: false,
          });
        }
        sinceSeqIds.push(query.sinceSeqId);
        if (!burstEnabled) {
          return respond(200, { events: [] });
        }
        const startIndex = page * 50;
        page += 1;
        const messages = burstMessages.slice(startIndex, startIndex + 50);
        if (messages.length < 50) {
          finalForwardPageRequested = true;
          await finalPageGate.promise;
        }
        return respond(200, { events: messages.map(chatEventResponse) });
      },
    );
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        unreads: [],
      });
    });

    try {
      detachedSetupPage({ context, path: `/chats/${threadId}` });

      await waitFor(() => {
        expect(screen.getByText("Baseline 0")).toBeInTheDocument();
        expect(context.mocks.ably.hasChannelSubscription()).toBeTruthy();
      });
      expect(
        context.mocks.ably.hasSubscription(
          `chatThreadMessageCreated:${threadId}`,
        ),
      ).toBeFalsy();
      expect(
        context.mocks.ably.hasSubscription(`chatThreadRunCreated:${threadId}`),
      ).toBeFalsy();
      sinceSeqIds.length = 0;
      burstEnabled = true;
      context.mocks.ably.triggerReconnect();

      await waitFor(() => {
        expect(finalForwardPageRequested).toBeTruthy();
      });
      expect(screen.queryByText("Burst 119")).not.toBeInTheDocument();

      finalPageGate.resolve();
      await waitFor(() => {
        expect(screen.getByText("Burst 119")).toBeInTheDocument();
      });
    } finally {
      if (!finalPageGate.settled()) {
        finalPageGate.resolve();
      }
    }
    expect(sinceSeqIds).toStrictEqual([
      baselineMessages.at(-1)!.seqId,
      burstMessages[49]!.seqId,
      burstMessages[99]!.seqId,
    ]);
  });
});
