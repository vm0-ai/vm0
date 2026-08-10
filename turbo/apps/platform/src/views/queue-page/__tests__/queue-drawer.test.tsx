import { screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  ConcurrencyInfo,
  QueueEntry,
  QueueResponse,
} from "@vm0/api-contracts/contracts/runs";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const THREAD_ID = "ea000000-0000-4000-a000-000000000001";

function queuedEntry(): QueueEntry {
  return {
    position: 1,
    agentName: "zero",
    agentDisplayName: "Zero",
    userEmail: "test@example.com",
    createdAt: "2026-01-01T00:00:02Z",
    isOwner: true,
    runId: "run-queued",
    prompt: "Queued prompt",
    triggerSource: "web",
    sessionLink: null,
  };
}

function queueResponse(overrides?: {
  concurrency?: ConcurrencyInfo;
  queue?: QueueEntry[];
}): QueueResponse {
  return {
    concurrency: overrides?.concurrency ?? {
      tier: "free" as const,
      limit: 1,
      active: 1,
      available: 0,
      memberUsage: [],
    },
    queue: overrides?.queue ?? [],
    runningTasks: [],
    estimatedTimePerRun: null,
  };
}

function concurrencyWithMemberUsage(): ConcurrencyInfo {
  return {
    tier: "custom",
    limit: 80,
    active: 17,
    available: 63,
    memberUsage: [
      { userId: "user-bingjie", displayName: "Bingjie Zang", active: 7 },
      { userId: "user-qiqi", displayName: "You Liang", active: 5 },
      { userId: "user-ethan", displayName: "Ethan Zhang", active: 3 },
      { userId: "user-linghan", displayName: "Linghan Hu", active: 2 },
    ],
  };
}

function mockConcurrencyCapability(
  canBuyConcurrency: boolean,
  concurrencySubscriptions: BillingStatusResponse["concurrencySubscriptions"] = [],
): void {
  const status: BillingStatusResponse = {
    tier: "pro",
    canBuyConcurrency,
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: true,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 2,
    concurrencySubscriptions,
  };
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, status);
  });
}

function mockQueuedThread(): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: THREAD_ID,
          agentId: "c0000000-0000-4000-a000-000000000001",
          title: "Queued thread",
          sortAt: "2026-01-01T00:00:02Z",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:02Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        },
      ],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
    if (query.sinceSeqId !== undefined || query.beforeSeqId !== undefined) {
      return respond(200, { events: [] });
    }

    return respond(200, {
      events: [
        {
          id: "msg-previous-user",
          threadId: THREAD_ID,
          eventType: "input.prompt" as const,
          content: null,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Previous prompt" }],
          },
          runId: "run-completed",
          seqId: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "msg-previous-assistant",
          threadId: THREAD_ID,
          eventType: "run.completed" as const,
          content: "Previous answer",
          runId: "run-completed",
          runLifecycleEvent: "completed",
          seqId: 2,
          createdAt: "2026-01-01T00:00:01Z",
        },
        {
          id: "msg-queued-marker",
          threadId: THREAD_ID,
          eventType: "run.queued" as const,
          content: "Waiting in queue...",
          runId: "run-queued",
          runEventId: "queue:queued",
          seqId: 3,
          createdAt: "2026-01-01T00:00:02Z",
        },
      ],
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((el) => {
    return el.textContent?.trim() === text;
  });

  if (!button) {
    throw new Error(`Could not find button: ${text}`);
  }

  return button;
}

async function openDrawer(memberUsageEnabled = false): Promise<void> {
  mockQueuedThread();
  detachedSetupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ConcurrencyMemberUsage]: memberUsageEnabled,
    },
  });
  const queueButton = await waitFor(() => {
    return getButtonByText("queue...");
  });
  click(queueButton);
}

describe("queue drawer", () => {
  it("shows active slot usage grouped by member", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({ concurrency: concurrencyWithMemberUsage() }),
      );
    });

    await openDrawer(true);

    await waitFor(() => {
      expect(screen.getByText("17 of 80 slots in use")).toBeInTheDocument();
      expect(screen.getByText("Bingjie Zang")).toBeInTheDocument();
      expect(screen.getByText("7 slots")).toBeInTheDocument();
      expect(screen.getByText("You Liang")).toBeInTheDocument();
      expect(screen.getByText("5 slots")).toBeInTheDocument();
      expect(screen.getByText("Ethan Zhang")).toBeInTheDocument();
      expect(screen.getByText("3 slots")).toBeInTheDocument();
      expect(screen.getByText("Linghan Hu")).toBeInTheDocument();
      expect(screen.getByText("2 slots")).toBeInTheDocument();
      expect(screen.getByText("Available now")).toBeInTheDocument();
      expect(screen.getByText("63 slots")).toBeInTheDocument();
    });
  });

  it("keeps the existing availability summary when member usage is disabled", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({ concurrency: concurrencyWithMemberUsage() }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("63 slots available")).toBeInTheDocument();
    });
    expect(screen.queryByText("Bingjie Zang")).not.toBeInTheDocument();
    expect(screen.queryByText("Available now")).not.toBeInTheDocument();
  });

  it("shows the free tier limit and upgrade path", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "free",
            limit: 1,
            active: 1,
            available: 0,
            memberUsage: [],
          },
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /waiting in line/ }),
      ).toBeInTheDocument();
      expect(screen.getByText("Free")).toBeInTheDocument();
      expect(screen.getByText(/only run 1 task/)).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Pro")).toBeInTheDocument();
    });
  });

  it("shows the Team upgrade path for Pro tier", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "pro",
            limit: 2,
            active: 2,
            available: 0,
            memberUsage: [],
          },
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Team")).toBeInTheDocument();
    });
  });

  it("shows additional concurrency checkout for Team admins", async () => {
    mockConcurrencyCapability(true);
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "team",
            limit: 5,
            active: 3,
            available: 2,
            memberUsage: [],
          },
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getAllByText("Team").length).toBeGreaterThan(0);
      expect(screen.getByText(/3 of 5 slots/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Upgrade to/)).not.toBeInTheDocument();
    expect(screen.getByText("Additional concurrency")).toBeInTheDocument();
    expect(screen.getByText("$100/month")).toBeInTheDocument();
    expect(screen.getByText("Buy $100/month")).toBeInTheDocument();
  });

  it("shows additional concurrency checkout for Custom admins without plan upgrade", async () => {
    mockConcurrencyCapability(true);
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "custom",
            limit: 10,
            active: 10,
            available: 0,
            memberUsage: [],
          },
          queue: [queuedEntry()],
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Custom")).toBeInTheDocument();
      expect(screen.getByText(/10 of 10 slots/)).toBeInTheDocument();
      expect(screen.getByText("Additional concurrency")).toBeInTheDocument();
      expect(screen.getByText("Buy $100/month")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Upgrade to/)).not.toBeInTheDocument();
  });

  it("starts Checkout for a Team admin buying concurrency for the first time", async () => {
    let checkoutQuantity: number | null = null;
    let checkoutSuccessUrl: string | null = null;
    mockConcurrencyCapability(true);
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "team",
            limit: 5,
            active: 5,
            available: 0,
            memberUsage: [],
          },
          queue: [queuedEntry()],
        }),
      );
    });
    context.mocks.api(
      zeroBillingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        checkoutQuantity = body.quantity;
        checkoutSuccessUrl = body.successUrl;
        return respond(200, {
          url: `https://checkout.stripe.com/test?concurrency=${body.quantity}`,
        });
      },
    );

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Additional concurrency")).toBeInTheDocument();
      expect(screen.getByText("$100/month")).toBeInTheDocument();
      expect(screen.getByText("Buy $100/month")).toBeInTheDocument();
    });

    const increaseQuantityButton = queryAllByRoleFast("button").find((el) => {
      return el.getAttribute("aria-label") === "Increase concurrency quantity";
    });
    if (!increaseQuantityButton) {
      throw new Error("Increase concurrency quantity button not found");
    }
    click(increaseQuantityButton);
    await waitFor(() => {
      expect(screen.getByText("Buy $200/month")).toBeInTheDocument();
    });

    click(screen.getByText("Buy $200/month"));

    await waitFor(() => {
      expect(checkoutQuantity).toBe(2);
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/test?concurrency=2",
      );
    });
    if (!checkoutSuccessUrl) {
      throw new Error("Concurrency checkout success URL was not captured");
    }
    const successUrl = new URL(checkoutSuccessUrl);
    expect(successUrl.pathname).toBe("/");
    expect(successUrl.searchParams.get("concurrency")).toBe("purchased");
  });

  it("reviews and confirms additional concurrency for an active subscription", async () => {
    let checkoutQuantity: number | null = null;
    let previewedSubscriptionId: string | null = null;
    let previewedQuantity: number | null = null;
    let confirmedSubscriptionId: string | null = null;
    let confirmedQuantity: number | null = null;
    mockConcurrencyCapability(true, [
      {
        id: "sub_concurrency_active",
        quantity: 2,
        currentPeriodEnd: "2026-09-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        canReduce: true,
        canChangeInApp: true,
      },
    ]);
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "team",
            limit: 12,
            active: 12,
            available: 0,
            memberUsage: [],
          },
          queue: [queuedEntry()],
        }),
      );
    });
    context.mocks.api(
      zeroBillingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        checkoutQuantity = body.quantity;
        return respond(200, {
          url: "https://checkout.stripe.com/unexpected",
        });
      },
    );
    context.mocks.api(
      zeroBillingConcurrencySubscriptionContract.previewChange,
      ({ params, body, respond }) => {
        previewedSubscriptionId = params.subscriptionId;
        previewedQuantity = body.quantity;
        return respond(200, {
          currentQuantity: 2,
          targetQuantity: body.quantity,
          immediateAmountCents: 4321,
          nextRecurringAmountCents: body.quantity * 10_000,
          currency: "usd",
        });
      },
    );
    context.mocks.api(
      zeroBillingConcurrencySubscriptionContract.confirmChange,
      ({ params, body, respond }) => {
        confirmedSubscriptionId = params.subscriptionId;
        confirmedQuantity = body.quantity;
        return respond(200, {
          status: "pending_payment",
          hostedInvoiceUrl:
            "https://invoice.stripe.test/queue-concurrency-change",
        });
      },
    );

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Buy $100/month")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Review the amount due now and your updated monthly subscription.",
        ),
      ).toBeInTheDocument();
    });
    const increaseQuantityButton = queryAllByRoleFast("button").find((el) => {
      return el.getAttribute("aria-label") === "Increase concurrency quantity";
    });
    if (!increaseQuantityButton) {
      throw new Error("Increase concurrency quantity button not found");
    }
    click(increaseQuantityButton);
    await waitFor(() => {
      expect(screen.getByText("Buy $200/month")).toBeInTheDocument();
    });

    click(screen.getByText("Buy $200/month"));

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review concurrency change",
    });
    expect(checkoutQuantity).toBeNull();
    expect(previewedSubscriptionId).toBe("sub_concurrency_active");
    expect(previewedQuantity).toBe(4);
    expect(within(reviewDialog).getByText("$43.21")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$400.00/month")).toBeInTheDocument();

    click(within(reviewDialog).getByText("Confirm"));

    await waitFor(() => {
      expect(confirmedSubscriptionId).toBe("sub_concurrency_active");
      expect(confirmedQuantity).toBe(4);
      expect(window.location.href).toBe(
        "https://invoice.stripe.test/queue-concurrency-change",
      );
    });
  });

  it("keeps the Checkout fallback for an active subscription from an older API", async () => {
    let checkoutQuantity: number | null = null;
    mockConcurrencyCapability(true, [
      {
        id: "sub_concurrency_legacy",
        quantity: 2,
        currentPeriodEnd: "2026-09-01T00:00:00Z",
        cancelAtPeriodEnd: false,
      },
    ]);
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "team",
            limit: 12,
            active: 12,
            available: 0,
            memberUsage: [],
          },
          queue: [queuedEntry()],
        }),
      );
    });
    context.mocks.api(
      zeroBillingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        checkoutQuantity = body.quantity;
        return respond(200, {
          url: "https://checkout.stripe.com/legacy-concurrency",
        });
      },
    );

    await openDrawer();
    await waitFor(() => {
      expect(screen.getByText("Buy $100/month")).toBeInTheDocument();
    });
    click(screen.getByText("Buy $100/month"));

    await waitFor(() => {
      expect(checkoutQuantity).toBe(1);
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/legacy-concurrency",
      );
    });
  });

  it("hides additional concurrency checkout when the plan capability is disabled", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    mockConcurrencyCapability(false);
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "team",
            limit: 5,
            active: 5,
            available: 0,
            memberUsage: [],
          },
          queue: [queuedEntry()],
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.getByText(/5 of 5 slots/)).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Additional concurrency"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Buy $100/month")).not.toBeInTheDocument();
  });

  it("hides billing actions from non-admins", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "member",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "pro",
            limit: 2,
            active: 2,
            available: 0,
            memberUsage: [],
          },
          queue: [queuedEntry()],
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Pro")).toBeInTheDocument();
      expect(screen.getByText(/2 of 2 slots/)).toBeInTheDocument();
    });
    expect(screen.queryByText("Upgrade to Team")).not.toBeInTheDocument();
  });

  it("hides additional concurrency checkout from non-admins", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "member",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "team",
            limit: 5,
            active: 5,
            available: 0,
            memberUsage: [],
          },
          queue: [queuedEntry()],
        }),
      );
    });

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.getByText(/5 of 5 slots/)).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Additional concurrency"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Buy $100/month")).not.toBeInTheDocument();
  });
});
