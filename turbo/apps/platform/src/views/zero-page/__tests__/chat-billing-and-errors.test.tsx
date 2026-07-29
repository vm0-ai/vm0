import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingStatusContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import {
  zeroRunAgentEventsContract,
  zeroRunsByIdContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, threadListSnapshot } from "./chat-test-helpers.ts";
import {
  context,
  detachedSetupPage,
  AGENT_ID,
  RUNNING_THREAD_ID,
  COMPLETED_THREAD_ID,
  buttonByText,
  queryButtonByText,
  mockThinkingTypewriterLayout,
  mockFailedAssistantThread,
} from "./chat-lifecycle-test-helpers.ts";

describe("chat lifecycle", () => {
  it("shows billing recovery guidance when credits are depleted", async () => {
    const threadId = "failed-guidance-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/recover?tier=${body.tier}`,
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(buttonByText("Upgrade to Pro")).toBeInTheDocument();
    });

    click(buttonByText("Upgrade to Pro"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/recover?tier=pro",
      );
    });
  });

  it("shows Pro upgrade guidance when built-in video requires Pro", async () => {
    const threadId = "failed-guidance-video-pro";
    mockFailedAssistantThread({ threadId, error: "pro_required" });
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/recover?tier=${body.tier}`,
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(buttonByText("Upgrade to Pro")).toBeInTheDocument();
    });

    click(buttonByText("Upgrade to Pro"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/recover?tier=pro",
      );
    });
  });

  it("shows Pro upgrade guidance for limited-free-1 even with credits", async () => {
    const threadId = "failed-guidance-limited-free";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "limited-free-1",
        credits: 1500,
        onboardingPaymentPending: false,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: false,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
        concurrencyLimit: 1,
        concurrencySubscriptions: [],
      });
    });
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/recover?tier=${body.tier}`,
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(buttonByText("Upgrade to Pro")).toBeInTheDocument();
      expect(screen.queryByText("Credits available")).toBeNull();
    });

    click(buttonByText("Upgrade to Pro"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/recover?tier=pro",
      );
    });
  });

  it("shows admin-only billing guidance when a member runs out of credits", async () => {
    const threadId = "failed-guidance-member-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Ask a workspace admin to upgrade to Pro so you can keep chatting with Zero.",
        ),
      ).toBeInTheDocument();
      expect(queryButtonByText("Upgrade to Pro")).toBeNull();
    });
  });

  it("shows that chat can continue when credits become available", async () => {
    const threadId = "failed-guidance-restored-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        credits: 1500,
        onboardingPaymentPending: false,
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: true,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
        concurrencyLimit: 0,
        concurrencySubscriptions: [],
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Credits available")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Your credits have been added. You can continue chatting with Zero.",
        ),
      ).toBeInTheDocument();
      expect(queryButtonByText("Upgrade to Pro")).toBeNull();
    });
  });

  it("shows paid credit top-ups when a paid workspace runs out of credits", async () => {
    const threadId = "failed-guidance-paid-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        credits: 0,
        onboardingPaymentPending: false,
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: true,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
        concurrencyLimit: 0,
        concurrencySubscriptions: [],
      });
    });
    context.mocks.api(
      zeroBillingCreditCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/credits?credits=${body.credits}`,
        });
      },
    );
    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("You're out of credits")).toBeInTheDocument();
      expect(
        screen.getByText("Add credits to keep chatting with Zero."),
      ).toBeInTheDocument();
      expect(buttonByText("$100")).toBeInTheDocument();
      expect(buttonByText("$200")).toBeInTheDocument();
      expect(buttonByText("$300")).toBeInTheDocument();
    });

    click(buttonByText("Custom"));
    await fill(screen.getByLabelText("Custom dollar amount"), "0");
    click(buttonByText("Buy"));

    await waitFor(() => {
      expect(
        screen.getByText("Enter between $1 and $10,000"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Custom dollar amount"), "25");
    click(buttonByText("Buy"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/credits?credits=25000",
      );
    });
  });

  it("uses the plan capability when a paid tier cannot buy credits", async () => {
    const threadId = "failed-guidance-capability-blocked-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        credits: 0,
        onboardingPaymentPending: false,
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: true,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
        concurrencyLimit: 2,
        concurrencySubscriptions: [],
        canBuyCredits: false,
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(buttonByText("Upgrade to Pro")).toBeInTheDocument();
      expect(queryButtonByText("$100")).toBeNull();
    });
  });

  it("shows credit top-ups when a Custom workspace runs out of credits", async () => {
    const threadId = "failed-guidance-custom-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "custom",
        credits: 0,
        onboardingPaymentPending: false,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: false,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
        concurrencyLimit: 10,
        concurrencySubscriptions: [],
      });
    });
    context.mocks.api(
      zeroBillingCreditCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/credits?credits=${body.credits}`,
        });
      },
    );
    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("You're out of credits")).toBeInTheDocument();
      expect(
        screen.getByText("Add credits to keep chatting with Zero."),
      ).toBeInTheDocument();
      expect(queryButtonByText("Upgrade to Pro")).toBeNull();
      expect(buttonByText("$100")).toBeInTheDocument();
      expect(buttonByText("$200")).toBeInTheDocument();
      expect(buttonByText("$300")).toBeInTheDocument();
    });

    click(buttonByText("$100"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/credits?credits=100000",
      );
    });
  });

  it("shows model-provider setup guidance from failed assistant messages", async () => {
    const threadId = "failed-guidance-provider";
    mockFailedAssistantThread({
      threadId,
      error: "No model provider configured",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText(/No model provider configured yet/u),
      ).toBeInTheDocument();
      expect(
        buttonByText("Set one up in Workspace Settings"),
      ).toBeInTheDocument();
    });
  });

  it("shows restart guidance for incompatible provider sessions", async () => {
    const threadId = "failed-guidance-incompatible";
    mockFailedAssistantThread({
      threadId,
      error: "Cannot continue session with the selected provider",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText(/started with a different model provider/u),
      ).toBeInTheDocument();
      expect(screen.getByText("Start a new session")).toBeInTheDocument();
    });
  });

  it("shows restart guidance for deleted provider sessions", async () => {
    const threadId = "failed-guidance-deleted";
    mockFailedAssistantThread({
      threadId,
      error: "Model provider unavailable",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText(
          /model provider used by this thread has been deleted/u,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Start a new chat thread")).toBeInTheDocument();
    });
  });

  it("renders generic assistant failures as markdown", async () => {
    const threadId = "failed-guidance-generic";
    mockFailedAssistantThread({
      threadId,
      error: "Unexpected **tool** failure",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(/Unexpected.*failure/u)).toBeInTheDocument();
      expect(screen.getByText("tool")).toBeInTheDocument();
    });
  });

  it("switches sessions without stale running or completed messages", async () => {
    const threads = [
      {
        id: RUNNING_THREAD_ID,
        title: "Running thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: COMPLETED_THREAD_ID,
        title: "Completed thread",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:01:00Z",
        updatedAt: "2026-03-10T00:01:00Z",
      },
    ];
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: threadListSnapshot(threads),
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(
      chatThreadEventsContract.list,
      ({ params, query, respond }) => {
        if (query.sinceSeqId || query.sinceId) {
          return respond(200, { events: [] });
        }
        if (params.threadId === RUNNING_THREAD_ID) {
          return respond(200, {
            events: [
              {
                id: "msg-running-user",
                threadId: RUNNING_THREAD_ID,
                eventType: "input.prompt" as const,
                content: "Active task prompt",
                userMessage: {
                  version: 1,
                  parts: [{ type: "text", text: "Active task prompt" }],
                },
                runId: "run-active",
                seqId: 1,
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "msg-running-assistant",
                threadId: RUNNING_THREAD_ID,
                eventType: "output.thinking" as const,
                thinking: "",
                content: null,
                runId: "run-active",
                seqId: 2,
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
          });
        }
        return respond(200, {
          events: [
            {
              id: "msg-completed-user",
              threadId: COMPLETED_THREAD_ID,
              eventType: "input.prompt" as const,
              content: "Done task",
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "Done task" }],
              },
              seqId: 1,
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-completed-assistant",
              threadId: COMPLETED_THREAD_ID,
              eventType: "output.message" as const,
              content: "All done!",
              seqId: 2,
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
        });
      },
    );
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, {
        id: "run-active",
        sessionId: "session-1",
        agentId: "zero",
        displayName: null,
        framework: "claude-code",
        modelProvider: null,
        selectedModel: null,
        triggerSource: "web",
        triggerAgentName: null,
        status: "running",
        prompt: "Active task prompt",
        appendSystemPrompt: null,
        error: null,
        createdAt: "2026-03-10T00:00:00Z",
        startedAt: "2026-03-10T00:00:01Z",
        completedAt: null,
        artifact: { name: null, version: null },
      });
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      },
    );
    context.mocks.api(zeroRunsByIdContract.getById, ({ respond }) => {
      return respond(200, {
        runId: "run-active",
        agentComposeVersionId: null,
        status: "running",
        prompt: "Active task prompt",
        appendSystemPrompt: null,
        result: { agentSessionId: "session-1", output: "" },
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(zeroQueuePositionContract.getPosition, ({ respond }) => {
      return respond(200, { position: 0, total: 0 });
    });

    detachedSetupPage({ context, path: `/chats/${RUNNING_THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    const completedThreadLink = await waitFor(() => {
      return queryAllByRoleFast("link").find((element) => {
        return element.getAttribute("href") === `/chats/${COMPLETED_THREAD_ID}`;
      });
    });
    if (!completedThreadLink) {
      throw new Error("Completed thread link not found");
    }
    click(completedThreadLink);

    await waitFor(() => {
      expect(screen.getByText("All done!")).toBeInTheDocument();
      expect(screen.queryByText("Active task prompt")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });
});
describe("initial thinking indicator", () => {
  it("renders the latest run thinking marker inside the thinking indicator", async () => {
    const threadId = "thread-initial-thinking";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-thinking-user",
          eventType: "input.prompt" as const,
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-marker",
          eventType: "output.thinking" as const,
          content: null,
          thinking: "Reviewing your request",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    const label = await screen.findByLabelText("Reviewing your request");
    expect(label.closest("[data-thinking-indicator]")).not.toBeNull();
  });

  it("renders the thinking marker before thread detail resolves", async () => {
    const threadId = "thread-initial-thinking-thread-detail-gated";
    const threadGate = context.mocks.deferred<void>();
    mockChatLifecycle(context, {
      threadId,
      threadGate: threadGate.promise,
      chatEvents: [
        {
          id: "msg-thinking-detail-gated-user",
          eventType: "input.prompt" as const,
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-detail-gated-marker",
          eventType: "output.thinking" as const,
          content: null,
          thinking: "Reading the prompt",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const label = await screen.findByLabelText("Reading the prompt");
    expect(label.closest("[data-thinking-indicator]")).not.toBeNull();

    threadGate.resolve();
  });

  it("restarts on every follow-up line instead of sliding a short tail", async () => {
    const threadId = "thread-initial-thinking-rollover";
    const thinking = "ABCDEFG";
    mockThinkingTypewriterLayout({
      text: thinking,
      labelWidth: 38,
      parentWidth: 160,
      graphemeWidth: 10,
      measureTextWidth: (value) => {
        return (
          Array.from(value).filter((grapheme) => {
            return grapheme !== ".";
          }).length * 10
        );
      },
    });
    const displayedLabels = new Set<string>();
    const labelObserver = new MutationObserver(() => {
      const label = document.querySelector(`[aria-label="${thinking}"]`);
      if (label?.textContent) {
        displayedLabels.add(label.textContent);
      }
    });
    labelObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    context.signal.addEventListener(
      "abort",
      () => {
        labelObserver.disconnect();
      },
      { once: true },
    );
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-thinking-rollover-user",
          eventType: "input.prompt" as const,
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-rollover-marker",
          eventType: "output.thinking" as const,
          content: null,
          thinking,
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const label = await screen.findByLabelText(thinking);
    const sawFollowUpLine = () => {
      if (label.textContent) {
        displayedLabels.add(label.textContent);
      }
      return Array.from(displayedLabels).some((value) => {
        return value === "D" || value === "DE" || value === "DEF";
      });
    };
    await waitFor(() => {
      expect(sawFollowUpLine()).toBeTruthy();
    });
    await waitFor(() => {
      expect(label).toHaveTextContent(/^G$/);
    });
    expect(displayedLabels.has("...EFG")).toBeFalsy();
    expect(label).not.toHaveTextContent(thinking);
    expect(label.closest("[data-thinking-indicator]")).not.toBeNull();
  });

  it("shows every explicit thinking line in sequence", async () => {
    const threadId = "thread-initial-thinking-multiline";
    const thinking = "ONE\nTWO\nTHREE";
    mockThinkingTypewriterLayout({
      text: thinking,
      labelWidth: 520,
      parentWidth: 640,
      graphemeWidth: 10,
    });
    const displayedLabels = new Set<string>();
    const recordDisplayedLabel = () => {
      const label = document.querySelector<HTMLParagraphElement>(
        "[data-thinking-indicator] p[aria-label]",
      );
      if (label?.textContent) {
        displayedLabels.add(label.textContent);
      }
    };
    const labelObserver = new MutationObserver(recordDisplayedLabel);
    labelObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    context.signal.addEventListener(
      "abort",
      () => {
        labelObserver.disconnect();
      },
      { once: true },
    );
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-thinking-multiline-user",
          eventType: "input.prompt" as const,
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-multiline-marker",
          eventType: "output.thinking" as const,
          content: null,
          thinking,
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const label = await waitFor(() => {
      const currentLabel = document.querySelector<HTMLParagraphElement>(
        "[data-thinking-indicator] p[aria-label]",
      );
      if (!currentLabel) {
        throw new Error("Thinking label not found");
      }
      expect(currentLabel).toHaveAttribute("aria-label", thinking);
      return currentLabel;
    });
    await waitFor(() => {
      recordDisplayedLabel();
      const displayedSequence = Array.from(displayedLabels);
      const firstLineIndex = displayedSequence.indexOf("ONE");
      const secondLineIndex = displayedSequence.indexOf("TWO");
      const thirdLineIndex = displayedSequence.indexOf("THREE");
      expect(firstLineIndex).toBeGreaterThanOrEqual(0);
      expect(secondLineIndex).toBeGreaterThan(firstLineIndex);
      expect(thirdLineIndex).toBeGreaterThan(secondLineIndex);
    });
    expect(label).toHaveTextContent(/^THREE$/);
    expect(label.closest("[data-thinking-indicator]")).not.toBeNull();
  });

  it("keeps the thinking marker visible while later messages are queued", async () => {
    const threadId = "thread-initial-thinking-with-queue";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-thinking-queued-user",
          eventType: "input.prompt" as const,
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-queued-marker",
          eventType: "output.thinking" as const,
          content: null,
          thinking: "Reviewing your request",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-thinking-queued-followup",
          eventType: "input.prompt" as const,
          content: "Also include owners",
          runId: undefined,
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const label = await screen.findByLabelText("Reviewing your request");
    expect(label.closest("[data-thinking-indicator]")).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Also include owners",
      );
    });
  });

  it("hides the thinking marker when the same run has assistant text", async () => {
    const threadId = "thread-initial-thinking-answer";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-thinking-answer-user",
          eventType: "input.prompt" as const,
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-answer-marker",
          eventType: "output.thinking" as const,
          content: null,
          thinking: "Reviewing your request",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-thinking-answer",
          eventType: "output.message" as const,
          content: "Here is the checklist.",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await screen.findByText("Here is the checklist.");
    expect(
      screen.queryByText("Reviewing your request"),
    ).not.toBeInTheDocument();
  });
});
