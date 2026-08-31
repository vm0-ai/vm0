import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import {
  billingStatus,
  buildModelPolicy,
  buildProvider,
} from "./chat-composer-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  SERVER_QUEUED_RUN_THREAD_ID,
  expectTextBefore,
  mockServerQueuedThreadStories,
  buttonByText,
  buttonByLabel,
} from "./chat-lifecycle-test-helpers.ts";

describe("chat lifecycle", () => {
  it("keeps budget inputs out of the visible transcript", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000001",
      chatEvents: [
        {
          id: "msg-budget-input-user",
          role: "user",
          eventType: "input.prompt",
          content: "Start the long-running task",
          runId: "run-budget-input",
          createdAt: "2026-08-06T00:00:00Z",
        },
        {
          id: "msg-budget-input-warning",
          role: "user",
          eventType: "input.budget",
          content: "The runner has five minutes remaining",
          runId: "run-budget-input",
          createdAt: "2026-08-06T01:55:00Z",
        },
        {
          id: "msg-budget-input-assistant",
          role: "assistant",
          eventType: "output.message",
          content: "The task summary is ready",
          runId: "run-budget-input",
          createdAt: "2026-08-06T01:55:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e7000000-0000-4000-a000-000000000001",
    });

    await expect(
      screen.findByText("Start the long-running task"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByText("The task summary is ready"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("The runner has five minutes remaining"),
    ).not.toBeInTheDocument();
  });

  it("shows run credit usage with friendly popover details", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000002",
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
            totalCredits: 24_234,
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
      path: "/chats/e7000000-0000-4000-a000-000000000002",
    });

    const credit = await waitFor(() => {
      return buttonByLabel("Credit usage 24,234");
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
      expect(screen.getAllByText("24,234").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("kimi-k2.5").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("1,234").length).toBeGreaterThanOrEqual(1);
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
      expect(screen.getAllByText("kimi-k2.5").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("1,234").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows run model names for limited-free-1 workspaces", async () => {
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(
        200,
        billingStatus("limited-free-1", {
          supportByok: false,
          restrictedVm0Models: true,
        }),
      );
    });
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000003",
      chatEvents: [
        {
          id: "msg-limited-free-usage-user",
          role: "user",
          content: "Summarize usage",
          runId: "run-limited-free-usage",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-limited-free-usage-assistant",
          role: "assistant",
          content: "Usage summary is ready.",
          runId: "run-limited-free-usage",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-limited-free-usage",
          role: "assistant",
          content: null,
          runId: "run-limited-free-usage",
          usage: {
            version: 1,
            totalCredits: 330,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model/gpt-5.6-luna/tokens.output",
                credits: 300,
                providers: [{ provider: "openai", credits: 300 }],
              },
              {
                kind: "image",
                credits: 30,
                providers: [{ provider: "gpt-image-2", credits: 30 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/e7000000-0000-4000-a000-000000000003",
    });

    click(await screen.findByLabelText("Credit usage 330"));

    await waitFor(() => {
      expect(screen.getAllByText("GPT 5.6 Luna").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("GPT Image 2").length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it("shows generation usage with model names only", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000004",
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
            totalCredits: 2076,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "image",
                credits: 96,
                providers: [{ provider: "fal-ai/nano-banana-2", credits: 96 }],
              },
              {
                kind: "video",
                credits: 1980,
                providers: [
                  {
                    provider: "dreamina-seedance-2-0-260128",
                    credits: 1880,
                  },
                  {
                    provider: "joggai-talking-avatar",
                    credits: 100,
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
      path: "/chats/e7000000-0000-4000-a000-000000000004",
    });

    const credit = await screen.findByLabelText("Credit usage 2,076");
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
      expect(
        screen.getAllByText("Avatar").some((element) => {
          return element.parentElement?.textContent === "Avatar100";
        }),
      ).toBeTruthy();
      expect(screen.queryByText(/fal\.? ?ai/iu)).not.toBeInTheDocument();
      expect(screen.queryByText(/dreamina/iu)).not.toBeInTheDocument();
      expect(screen.queryByText(/joggai/iu)).not.toBeInTheDocument();
    });
  });

  it("shows the replacement run usage settlement", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000005",
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
          revokesEventId: "msg-usage-settlement-first",
          usage: {
            version: 1,
            totalCredits: 108,
            settledAt: "2026-06-09T10:00:02Z",
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
      path: "/chats/e7000000-0000-4000-a000-000000000005",
    });

    await expect(
      screen.findByLabelText("Credit usage 108"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Credit usage 12")).not.toBeInTheDocument();
  });

  it("localizes managed API usage when completed work is folded", async () => {
    document.documentElement.lang = "pt-BR";
    await initializeI18n("pt-BR");
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000006",
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
      path: "/chats/e7000000-0000-4000-a000-000000000006",
    });

    await expect(
      screen.findByText("Managed API usage is ready."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Inspecting managed API results."),
    ).not.toBeInTheDocument();

    const managedApiCredit = await screen.findByLabelText(
      "Uso de créditos 216",
    );
    click(managedApiCredit);

    await waitFor(() => {
      expect(screen.getByText("Coleta da web")).toBeInTheDocument();
      expect(screen.getByText("Mapas")).toBeInTheDocument();
      expect(screen.getByText("Pesquisa na web")).toBeInTheDocument();
      expect(screen.getByText("Pesquisa de pessoas")).toBeInTheDocument();
      expect(screen.getByText("Finanças")).toBeInTheDocument();
      expect(screen.getByText("Clima")).toBeInTheDocument();
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
      threadId: "e7000000-0000-4000-a000-000000000007",
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
      path: "/chats/e7000000-0000-4000-a000-000000000007",
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
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "text",
                text: "Follow up when the queued run starts",
              },
              { type: "morning_brief", briefDate: "2026-06-09" },
            ],
          },
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
      expect(
        queryAllByRoleFast("button").some((button) => {
          return button.textContent === "queue...";
        }),
      ).toBeTruthy();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });

    click(
      within(screen.getByTestId("chat-list-column")).getByText(
        "Resolved server queue",
      ),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Queued deployment is running now."),
      ).toBeInTheDocument();
      expect(
        queryAllByRoleFast("button").some((button) => {
          return button.textContent === "queue...";
        }),
      ).toBeFalsy();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("keeps chat work visible while the run is active", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000008",
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
      path: "/chats/e7000000-0000-4000-a000-000000000008",
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
      threadId: "e7000000-0000-4000-a000-000000000009",
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
      path: "/chats/e7000000-0000-4000-a000-000000000009",
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
      threadId: "e7000000-0000-4000-a000-000000000010",
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
      path: "/chats/e7000000-0000-4000-a000-000000000010",
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

  it.each([
    {
      name: "splits one completed run into folds at user boundaries",
      caseId: "two-folds",
      threadId: "e7000000-0000-4000-a000-000000000023",
      sequence: ["U1", "A2", "A3", "A4", "U2", "A5", "A6", "A7", "A8"],
      visibleOrder: [
        "U1",
        "Worked for 30s",
        "A4",
        "U2",
        "Worked for 40s",
        "A8",
      ],
      usageAssistant: "A8",
      folds: [
        {
          label: "Worked for 30s",
          hidden: ["A2", "A3"],
          final: "A4",
        },
        {
          label: "Worked for 40s",
          hidden: ["A5", "A6", "A7"],
          final: "A8",
        },
      ],
    },
    {
      name: "keeps one assistant before a trailing user unfolded",
      caseId: "single-assistant-before-user",
      threadId: "e7000000-0000-4000-a000-000000000024",
      sequence: ["U1", "A2", "U2"],
      visibleOrder: ["U1", "A2", "U2"],
      usageAssistant: "A2",
      folds: [],
    },
    {
      name: "folds earlier assistant work before a trailing user",
      caseId: "fold-before-user",
      threadId: "e7000000-0000-4000-a000-000000000025",
      sequence: ["U1", "A2", "A3", "U2"],
      visibleOrder: ["U1", "Worked for 20s", "A3", "U2"],
      usageAssistant: "A3",
      folds: [
        {
          label: "Worked for 20s",
          hidden: ["A2"],
          final: "A3",
        },
      ],
    },
    {
      name: "keeps one assistant in each user phase unfolded",
      caseId: "single-assistant-per-phase",
      threadId: "e7000000-0000-4000-a000-000000000026",
      sequence: ["U1", "A2", "U2", "A3"],
      visibleOrder: ["U1", "A2", "U2", "A3"],
      usageAssistant: "A3",
      folds: [],
    },
  ])(
    "$name",
    async ({
      caseId,
      threadId,
      sequence,
      visibleOrder,
      usageAssistant,
      folds,
    }) => {
      const runId = `run-work-folding-${caseId}`;
      const chatEvents: MockChatEventInput[] = sequence.map(
        (content, index) => {
          const createdAt = new Date(
            Date.UTC(2026, 7, 5, 10, 0, index * 10),
          ).toISOString();
          if (content.startsWith("U")) {
            return { role: "user", content, runId, createdAt };
          }
          return {
            role: "assistant",
            content,
            runId,
            createdAt,
            ...(index === sequence.length - 1
              ? { runLifecycleEvent: "completed" as const }
              : {}),
          };
        },
      );
      if (sequence.at(-1)?.startsWith("U")) {
        chatEvents.push({
          role: "assistant",
          content: null,
          runId,
          runLifecycleEvent: "completed",
          createdAt: new Date(
            Date.UTC(2026, 7, 5, 10, 0, sequence.length * 10),
          ).toISOString(),
        });
      }
      chatEvents.push({
        role: "assistant",
        content: null,
        runId,
        usage: {
          version: 1,
          totalCredits: 12,
          settledAt: new Date(
            Date.UTC(2026, 7, 5, 10, 0, sequence.length * 10 + 1),
          ).toISOString(),
          breakdown: [],
        },
        createdAt: new Date(
          Date.UTC(2026, 7, 5, 10, 0, sequence.length * 10 + 1),
        ).toISOString(),
      });
      mockChatLifecycle(context, { threadId, chatEvents });

      detachedSetupPage({
        context,
        path: `/chats/${threadId}`,
      });

      await screen.findByText(visibleOrder[0]!);
      const expandButtons = screen.queryAllByLabelText("Expand work history");
      expect(expandButtons).toHaveLength(folds.length);
      for (const [index, fold] of folds.entries()) {
        const expandButton = expandButtons[index]!;
        expect(expandButton).toHaveTextContent(fold.label);
        const assistantGroup = expandButton.closest(
          '[data-role="assistant"]',
        ) as HTMLElement | null;
        expect(assistantGroup).not.toBeNull();
        expect(
          within(assistantGroup!).getByText(fold.final),
        ).toBeInTheDocument();
        for (const hidden of fold.hidden) {
          expect(within(assistantGroup!).queryByText(hidden)).toBeNull();
        }
      }
      for (let index = 1; index < visibleOrder.length; index++) {
        expectTextBefore(
          document.body,
          visibleOrder[index - 1]!,
          visibleOrder[index]!,
        );
      }
      for (const [index, fold] of folds.entries()) {
        const expandButton = expandButtons[index]!;
        const assistantGroup = expandButton.closest(
          '[data-role="assistant"]',
        ) as HTMLElement;
        click(expandButton);
        await waitFor(() => {
          for (const hidden of fold.hidden) {
            expect(
              within(assistantGroup).getByText(hidden),
            ).toBeInTheDocument();
          }
        });
      }

      const usageButtons = screen.queryAllByLabelText("Credit usage 12");
      expect(usageButtons).toHaveLength(1);
      const usageAssistantGroup = usageButtons[0]!.closest(
        '[data-role="assistant"]',
      ) as HTMLElement | null;
      expect(usageAssistantGroup).not.toBeNull();
      expect(
        within(usageAssistantGroup!).getByText(usageAssistant),
      ).toBeInTheDocument();
    },
  );

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
      threadId: "e7000000-0000-4000-a000-000000000011",
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
          followups: [
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
      path: "/chats/e7000000-0000-4000-a000-000000000011",
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
    const finishedDivider = finishedLabel.parentElement;
    const finishedRunRow = finishedDivider!.parentElement;
    expect(finishedRunRow).toHaveClass("flex", "flex-col", "gap-2");
    expect(finishedRunRow).not.toHaveClass(
      "rounded-[var(--zero-card-radius)]",
      "bg-gray-50",
      "p-3",
    );
    expect(followupList!.parentElement).toBe(finishedRunRow);
    expect(finishedDivider).toHaveClass(
      "flex",
      "min-h-5",
      "items-center",
      "gap-2",
    );
    expect(finishedDivider).toHaveTextContent(
      `Keep going · ${completedAtLabel}`,
    );
    expect(finishedDivider!.children).toHaveLength(2);
    expect(finishedDivider!.firstElementChild).toBe(finishedLabel);
    expect(finishedDivider!.lastElementChild).toHaveClass(
      "h-px",
      "flex-1",
      "bg-border/40",
    );
    expect(finishedDivider!.querySelector(".w-full")).toBeNull();
  });

  it.each([
    {
      locale: "pt-BR",
      userMessage: "Prepare o plano de lançamento",
      assistantMessage: "O plano de lançamento está pronto.",
      followup: "Transforme em uma apresentação",
      keepGoing: "Continuar",
    },
    {
      locale: "ko-KR",
      userMessage: "출시 계획을 준비해 주세요",
      assistantMessage: "출시 계획이 준비되었습니다.",
      followup: "프레젠테이션으로 만들어 주세요",
      keepGoing: "계속 진행",
    },
  ] as const)(
    "formats completed-run timestamps with the selected $locale locale",
    async ({ locale, userMessage, assistantMessage, followup, keepGoing }) => {
      const completedAt = "2026-06-09T10:00:21Z";
      const completedAtLabel = new Date(completedAt).toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      context.mocks.data.userPreferences({ locale });
      mockChatLifecycle(context, {
        threadId: "e7000000-0000-4000-a000-000000000012",
        chatEvents: [
          {
            role: "user",
            content: userMessage,
            runId: "run-localized-completed-run",
            createdAt: "2026-06-09T10:00:00Z",
          },
          {
            role: "assistant",
            content: assistantMessage,
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
            followups: [
              {
                prompt: followup,
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
        path: "/chats/e7000000-0000-4000-a000-000000000012",
      });

      await expect(
        screen.findByText(`${keepGoing} · ${completedAtLabel}`),
      ).resolves.toBeInTheDocument();
      expect(document.documentElement.lang).toBe(locale);
    },
  );

  it("formats completed-run timestamps with the selected Japanese locale", async () => {
    const completedAt = "2026-06-09T10:00:21Z";
    const completedAtLabel = new Date(completedAt).toLocaleString("ja-JP", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    context.mocks.data.userPreferences({
      locale: "ja-JP",
      supportedLocales: ["en-US", "ja-JP"],
    });
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000013",
      chatEvents: [
        {
          role: "user",
          content: "リリース計画を準備してください",
          runId: "run-japanese-completed-run",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "リリース計画が完了しました。",
          runId: "run-japanese-completed-run",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-japanese-completed-run",
          runLifecycleEvent: "completed",
          createdAt: completedAt,
        },
        {
          role: "assistant",
          content: null,
          runId: "run-japanese-completed-run",
          followups: [
            {
              prompt: "プレゼンテーションに変換する",
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
      path: "/chats/e7000000-0000-4000-a000-000000000013",
    });

    await expect(
      screen.findByText(`続ける · ${completedAtLabel}`),
    ).resolves.toBeInTheDocument();
    expect(document.documentElement.lang).toBe("ja-JP");
  });

  it("formats completed-run timestamps with the selected Spanish locale", async () => {
    const completedAt = "2026-06-09T10:00:21Z";
    const completedAtLabel = new Date(completedAt).toLocaleString("es-ES", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    context.mocks.data.userPreferences({ locale: "es-ES" });
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000014",
      chatEvents: [
        {
          role: "user",
          content: "Prepara el plan de lanzamiento",
          runId: "run-spanish-completed-run",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "El plan de lanzamiento está listo.",
          runId: "run-spanish-completed-run",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-spanish-completed-run",
          runLifecycleEvent: "completed",
          createdAt: completedAt,
        },
        {
          role: "assistant",
          content: null,
          runId: "run-spanish-completed-run",
          followups: [
            {
              prompt: "Convertir en una presentación",
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
      path: "/chats/e7000000-0000-4000-a000-000000000014",
    });

    await expect(
      screen.findByText(`Sigue adelante · ${completedAtLabel}`),
    ).resolves.toBeInTheDocument();
    expect(document.documentElement.lang).toBe("es-ES");
  });

  it("folds each completed run independently", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000015",
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
      path: "/chats/e7000000-0000-4000-a000-000000000015",
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
      threadId: "e7000000-0000-4000-a000-000000000016",
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
      path: "/chats/e7000000-0000-4000-a000-000000000016",
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
      threadId: "e7000000-0000-4000-a000-000000000017",
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
      path: "/chats/e7000000-0000-4000-a000-000000000017",
    });

    await waitFor(() => {
      expect(screen.getByText("Answer directly")).toBeInTheDocument();
      expect(screen.getByText("Direct answer.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("does not fold a completed run when the only prior assistant message is thinking", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000018",
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
      path: "/chats/e7000000-0000-4000-a000-000000000018",
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
      threadId: "e7000000-0000-4000-a000-000000000019",
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
      path: "/chats/e7000000-0000-4000-a000-000000000019",
    });

    await waitFor(() => {
      expect(screen.getByText("Standalone run result.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("renders a server-corrected assistant message without the stale answer", async () => {
    mockChatLifecycle(context, {
      threadId: "e7000000-0000-4000-a000-000000000020",
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
      path: "/chats/e7000000-0000-4000-a000-000000000020",
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
      threadId: "e7000000-0000-4000-a000-000000000021",
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
      path: "/chats/e7000000-0000-4000-a000-000000000021",
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("Paused mid-thought — pick it back up whenever."),
      ).toHaveLength(1);
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it.each([
    {
      name: "Codex usage limit",
      threadId: "e7000000-0000-4000-a000-000000000027",
      error:
        "You've hit your usage limit. Try again at 5:00 PM (Asia/Shanghai).",
      title: "Codex limit reached",
    },
    {
      name: "Claude Code session limit",
      threadId: "e7000000-0000-4000-a000-000000000028",
      error: "You've hit your session limit · resets 5:00 PM (Asia/Shanghai)",
      title: "Claude Code limit reached",
    },
    {
      name: "Claude usage limit",
      threadId: "e7000000-0000-4000-a000-000000000029",
      error:
        "Claude usage limit reached. Visit https://claude.ai/settings/usage or try again at 6:17 AM.",
      title: "Claude Code limit reached",
    },
    {
      name: "Codex model capacity",
      threadId: "e7000000-0000-4000-a000-000000000030",
      error: "Selected model is at capacity. Please try a different model.",
      title: "Codex model is busy",
    },
    {
      name: "Claude Code model capacity",
      threadId: "e7000000-0000-4000-a000-000000000031",
      error:
        "Claude Sonnet 4.6 is overloaded. Please wait a few minutes and try again, or switch to another model.",
      title: "Claude Code model is busy",
    },
  ])(
    "recognizes the latest $name error",
    async ({ threadId, error, title }) => {
      mockChatLifecycle(context, {
        threadId,
        chatEvents: [
          {
            id: `${threadId}-user`,
            role: "user",
            content: "Continue",
            runId: `${threadId}-run`,
            createdAt: "2026-07-30T09:00:00Z",
          },
          {
            id: `${threadId}-failure`,
            role: "assistant",
            content: null,
            error,
            runId: `${threadId}-run`,
            runLifecycleEvent: "failed",
            createdAt: "2026-07-30T09:00:01Z",
          },
        ],
      });

      detachedSetupPage({
        context,
        featureSwitches: { [FeatureSwitchKey.ChatErrorRecovery]: true },
        path: `/chats/${threadId}`,
      });

      const recoveryTitle = await screen.findByText(title);
      expect(recoveryTitle).toBeInTheDocument();
      expect(
        screen.getByTestId("assistant-error-recovery"),
      ).toBeInTheDocument();
    },
  );

  it("shows limited-free recovery models with Pro gating", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000789";
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(
        200,
        billingStatus("limited-free-1", {
          supportByok: false,
          restrictedVm0Models: true,
        }),
      );
    });
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000968",
        model: "deepseek-v4-flash",
        modelLabel: "DeepSeek V4 Flash",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000969",
        model: "gpt-5.6-luna",
        modelLabel: "GPT 5.6 Luna",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000970",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId,
      selectedModel: "deepseek-v4-flash",
      chatEvents: [
        {
          id: "limited-free-capacity-user",
          role: "user",
          content: "Continue",
          runId: "limited-free-capacity-run",
          createdAt: "2026-07-30T09:00:00Z",
        },
        {
          id: "limited-free-capacity-failure",
          role: "assistant",
          content: null,
          error:
            "The selected model is at capacity. Please try a different model.",
          runId: "limited-free-capacity-run",
          runLifecycleEvent: "failed",
          createdAt: "2026-07-30T09:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatErrorRecovery]: true },
      path: `/chats/${threadId}`,
    });

    const card = await screen.findByTestId("assistant-error-recovery");
    click(within(card).getByRole("combobox", { name: "Switch model" }));

    const deepseek = await screen.findByRole("option", {
      name: /DeepSeek V4 Flash/u,
    });
    const luna = screen.getByRole("option", { name: /GPT 5\.6 Luna/u });
    expect(deepseek).not.toHaveTextContent("Pro");
    expect(luna).not.toHaveTextContent("Pro");
    expect(
      screen.getByRole("option", { name: /GPT 5\.6 Sol.*Pro/u }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      name: "Codex",
      threadId: "b0000000-0000-4000-a000-000000000790",
      selectedModel: "gpt-5.6-sol",
      error:
        "You've hit your usage limit. Try again at 5:00 PM (Asia/Shanghai).",
      resetText: "Resets 5:00 PM (Asia/Shanghai)",
      currentOption: /GPT 5\.6 Sol/u,
      otherOption: /Claude Sonnet 4\.6/u,
    },
    {
      name: "Claude Code",
      threadId: "b0000000-0000-4000-a000-000000000793",
      selectedModel: "claude-sonnet-4-6",
      error: "You've hit your session limit · resets 5:00 PM",
      resetText: "Resets 5:00 PM",
      currentOption: /Claude Sonnet 4\.6/u,
      otherOption: /GPT 5\.6 Sol/u,
    },
  ])(
    "keeps the current model selectable and shows its reset time for a $name framework limit",
    async ({
      threadId,
      selectedModel,
      error,
      resetText,
      currentOption,
      otherOption,
    }) => {
      context.mocks.data.orgModelPolicies([
        buildModelPolicy({
          id: "00000000-0000-4000-a000-000000000971",
          model: "gpt-5.6-sol",
          modelLabel: "GPT 5.6 Sol",
          isDefault: selectedModel === "gpt-5.6-sol",
          defaultProviderType: "codex-oauth-token",
          credentialScope: "member",
        }),
        buildModelPolicy({
          id: "00000000-0000-4000-a000-000000000972",
          model: "claude-sonnet-4-6",
          modelLabel: "Claude Sonnet 4.6",
          isDefault: selectedModel === "claude-sonnet-4-6",
          defaultProviderType: "claude-code-oauth-token",
          credentialScope: "member",
        }),
      ]);
      mockChatLifecycle(context, {
        threadId,
        selectedModel,
        chatEvents: [
          {
            id: "codex-limit-user",
            role: "user",
            content: "Continue",
            runId: "codex-limit-run",
            createdAt: "2026-07-30T09:00:00Z",
          },
          {
            id: "codex-limit-failure",
            role: "assistant",
            content: null,
            error,
            runId: "codex-limit-run",
            runLifecycleEvent: "failed",
            createdAt: "2026-07-30T09:00:01Z",
          },
        ],
      });

      detachedSetupPage({
        context,
        featureSwitches: { [FeatureSwitchKey.ChatErrorRecovery]: true },
        path: `/chats/${threadId}`,
      });

      const card = await screen.findByTestId("assistant-error-recovery");
      expect(within(card).getByText(resetText)).toBeInTheDocument();
      click(within(card).getByRole("combobox", { name: "Switch model" }));

      const alternative = await screen.findByRole("option", {
        name: otherOption,
      });
      expect(alternative).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: currentOption }),
      ).toBeInTheDocument();
    },
  );

  it("resets a personal Codex subscription before trying again", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000791";
    let retriedPrompt: string | undefined;
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000974",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([
      buildProvider({
        id: "00000000-0000-4000-a000-000000000975",
        type: "codex-oauth-token",
        framework: "codex",
        secretName: null,
        authMethod: "auth_json",
        secretNames: ["CODEX_AUTH_JSON"],
        planType: "plus",
        subscriptionResetCredits: 1,
      }),
    ]);
    mockChatLifecycle(context, {
      threadId,
      selectedModel: "gpt-5.6-sol",
      chatEvents: [
        {
          id: "codex-reset-user",
          role: "user",
          content: "Continue",
          runId: "codex-reset-run",
          createdAt: "2026-07-30T09:00:00Z",
        },
        {
          id: "codex-reset-failure",
          role: "assistant",
          content: null,
          error: "You've hit your usage limit. Try again at 5:00 PM.",
          runId: "codex-reset-run",
          runLifecycleEvent: "failed",
          createdAt: "2026-07-30T09:00:01Z",
        },
      ],
      onRunCreate: (body) => {
        retriedPrompt = body.prompt;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatErrorRecovery]: true },
      path: `/chats/${threadId}`,
    });

    click(
      await waitFor(() => {
        return buttonByText("Reset and try again");
      }),
    );
    await waitFor(() => {
      expect(retriedPrompt).toBe("try again");
    });
  });

  it("keeps the current model and alternatives for model capacity and retries", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000792";
    let retriedPrompt: string | undefined;
    let retriedUserMessage: unknown;
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000976",
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: true,
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000977",
        model: "claude-opus-4-8",
        modelLabel: "Claude Opus 4.8",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000978",
        model: "gpt-5.6-sol",
        modelLabel: "GPT 5.6 Sol",
        defaultProviderType: "codex-oauth-token",
      }),
    ]);
    mockChatLifecycle(context, {
      threadId,
      selectedModel: "claude-sonnet-4-6",
      chatEvents: [
        {
          id: "claude-capacity-user",
          role: "user",
          content: "Continue",
          runId: "claude-capacity-run",
          createdAt: "2026-07-30T09:00:00Z",
        },
        {
          id: "claude-capacity-failure",
          role: "assistant",
          content: null,
          error:
            "Claude Sonnet 4.6 is overloaded. Please wait a few minutes and try again, or switch to another model.",
          runId: "claude-capacity-run",
          runLifecycleEvent: "failed",
          createdAt: "2026-07-30T09:00:01Z",
        },
      ],
      onRunCreate: (body) => {
        retriedPrompt = body.prompt;
        retriedUserMessage = body.userMessage;
      },
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatErrorRecovery]: true },
      path: `/chats/${threadId}`,
    });

    const card = await screen.findByTestId("assistant-error-recovery");
    click(within(card).getByRole("combobox", { name: "Switch model" }));
    const claudeOption = await screen.findByRole("option", {
      name: /Claude Opus 4.8/u,
    });
    expect(claudeOption).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /GPT 5\.6 Sol/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Claude Sonnet 4\.6/u }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    click(buttonByText("Try again", card));
    await waitFor(() => {
      expect(retriedPrompt).toBe("try again");
      expect(retriedUserMessage).toMatchObject({
        version: 1,
        parts: [{ type: "text", text: "try again" }],
      });
    });
  });

  it("keeps the provider error unchanged when recovery is disabled", async () => {
    const threadId = "e7000000-0000-4000-a000-000000000022";
    const error =
      "You've hit your usage limit. Try again at 5:00 PM (Asia/Shanghai).";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "recovery-disabled-user",
          role: "user",
          content: "Continue",
          runId: "recovery-disabled-run",
          createdAt: "2026-07-30T09:00:00Z",
        },
        {
          id: "recovery-disabled-failure",
          role: "assistant",
          content: null,
          error,
          runId: "recovery-disabled-run",
          runLifecycleEvent: "failed",
          createdAt: "2026-07-30T09:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatErrorRecovery]: false },
      path: `/chats/${threadId}`,
    });

    const providerError = await screen.findByText(error);
    expect(providerError).toBeInTheDocument();
    expect(
      screen.queryByTestId("assistant-error-recovery"),
    ).not.toBeInTheDocument();
  });
});
