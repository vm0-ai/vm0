import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { runsQueueContract } from "@okouai/api-contracts/contracts/run-routes";
import type {
  ConcurrencyInfo,
  QueueEntry,
  QueueResponse,
} from "@okouai/api-contracts/contracts/runs";
import { describe, expect, it } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPageAndWaitForContent,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { mockChatEventRows } from "../../okou-page/__tests__/chat-event-test-helpers.ts";

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
  purchaseReviewAvailable = false,
  concurrencyUnitAmountCents = 10_000,
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
    concurrencyUnitAmountCents,
    ...(purchaseReviewAvailable
      ? { concurrencyPurchaseReviewAvailable: true }
      : {}),
  };
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
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
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    return respond(
      200,
      chatEventRowsResponse(
        mockChatEventRows([
          {
            id: "msg-previous-user",
            threadId: THREAD_ID,
            eventType: "input.prompt",
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
            eventType: "output.message",
            content: "Previous answer",
            runId: "run-completed",
            seqId: 2,
            createdAt: "2026-01-01T00:00:01Z",
          },
          {
            id: "msg-previous-completed",
            threadId: THREAD_ID,
            eventType: "run.completed",
            content: null,
            runId: "run-completed",
            runLifecycleEvent: "completed",
            seqId: 3,
            createdAt: "2026-01-01T00:00:01Z",
          },
          {
            id: "msg-queued-marker",
            threadId: THREAD_ID,
            eventType: "run.queued",
            content: "Waiting in queue...",
            runId: "run-queued",
            runEventId: "queue:queued",
            seqId: 4,
            createdAt: "2026-01-01T00:00:02Z",
          },
        ]).filter((row) => {
          return row.seqId > query.sinceSeqId;
        }),
        query,
      ),
    );
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

function getButtonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.getAttribute("aria-label") === label;
  });

  if (!button) {
    throw new Error(`Could not find button with label: ${label}`);
  }

  return button;
}

async function openDrawer(
  sharedWorkerTestTransport: "direct" | "message-port" = "direct",
): Promise<void> {
  mockQueuedThread();
  await setupPageAndWaitForContent({
    context,
    path: `/chats/${THREAD_ID}`,
    sharedWorkerTestTransport,
  });
  const queueButton = await waitFor(() => {
    return getButtonByText("queue...");
  });
  click(queueButton);
}

describe("queue drawer", () => {
  it("shows active slot usage grouped by member", async () => {
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({ concurrency: concurrencyWithMemberUsage() }),
      );
    });

    await openDrawer();

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

  it("shows the free tier limit and upgrade path", async () => {
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
      expect(screen.getByText("1 of 1 slot in use")).toBeInTheDocument();
      expect(screen.getByText("Available now")).toBeInTheDocument();
      expect(screen.getByText("0 slots")).toBeInTheDocument();
      expect(screen.getByText("Upgrade to Pro")).toBeInTheDocument();
    });
  });

  it("shows the Team upgrade path for Pro tier", async () => {
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
    mockConcurrencyCapability(true, [], false, 4200);
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
    expect(screen.getByText("$42/month")).toBeInTheDocument();
    expect(screen.getByText("Buy $42/month")).toBeInTheDocument();
  });

  it("refreshes the concurrency limit through the shared worker when billing changes in realtime", async () => {
    let concurrencyLimit = 5;
    mockConcurrencyCapability(true);
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: {
            tier: "team",
            limit: concurrencyLimit,
            active: 3,
            available: concurrencyLimit - 3,
            memberUsage: [],
          },
        }),
      );
    });

    await openDrawer("message-port");

    await waitFor(() => {
      expect(screen.getByText(/3 of 5 slots/)).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });

    concurrencyLimit = 6;
    context.mocks.ably.trigger("billing:changed");

    await waitFor(() => {
      expect(screen.getByText(/3 of 6 slots/)).toBeInTheDocument();
      expect(screen.getByText("Available now")).toBeInTheDocument();
      expect(screen.getByText("3 slots")).toBeInTheDocument();
    });
  });

  it("shows additional concurrency checkout for Custom admins without plan upgrade", async () => {
    mockConcurrencyCapability(true);
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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

  it("reviews and confirms concurrency for a Team admin buying it for the first time", async () => {
    let checkoutQuantity: number | null = null;
    let checkoutSuccessUrl: string | null = null;
    let previewQuantity: number | null = null;
    mockConcurrencyCapability(true, [], true);
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
      billingConcurrencyCheckoutContract.preview,
      ({ body, respond }) => {
        previewQuantity = body.quantity;
        return respond(200, {
          currentQuantity: 0,
          targetQuantity: body.quantity,
          immediateAmountCents: 7000,
          nextRecurringAmountCents: 22_000,
          currency: "usd",
        });
      },
    );
    context.mocks.api(
      billingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        checkoutQuantity = body.quantity;
        checkoutSuccessUrl = body.successUrl;
        return respond(200, { url: body.successUrl });
      },
    );

    await openDrawer();

    await waitFor(() => {
      expect(screen.getByText("Additional concurrency")).toBeInTheDocument();
      expect(screen.getByText("$100/month")).toBeInTheDocument();
      expect(screen.getByText("Buy $100/month")).toBeInTheDocument();
    });

    const quantityInput = screen.getByRole("textbox", {
      name: "Quantity",
    });
    expect(
      getButtonByLabel("Decrease concurrency quantity"),
    ).toBeInTheDocument();
    expect(
      getButtonByLabel("Increase concurrency quantity"),
    ).toBeInTheDocument();
    fireEvent.change(quantityInput, { target: { value: "" } });
    expect(quantityInput).toHaveValue("");
    expect(getButtonByText("Buy $0/month")).toBeDisabled();
    fireEvent.change(quantityInput, { target: { value: "5" } });
    await waitFor(() => {
      expect(screen.getByText("Buy $500/month")).toBeInTheDocument();
    });

    const buyButton = getButtonByText("Buy $500/month");
    click(buyButton);

    await screen.findByText("$70.00");
    const reviewDialog = screen.getByRole("dialog", {
      name: "Review concurrency purchase",
    });
    expect(buyButton).toHaveTextContent("Updating...");
    expect(buyButton).toBeDisabled();
    expect(previewQuantity).toBe(5);
    expect(within(reviewDialog).getByText("5")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$220.00/month")).toBeInTheDocument();
    click(within(reviewDialog).getByText("Pay and add slots"));

    await waitFor(() => {
      expect(checkoutQuantity).toBe(5);
      expect(
        screen.queryByRole("dialog", { name: "Review concurrency purchase" }),
      ).toBeNull();
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
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
      billingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        checkoutQuantity = body.quantity;
        return respond(200, {
          url: "https://checkout.stripe.com/unexpected",
        });
      },
    );
    context.mocks.api(
      billingConcurrencySubscriptionContract.previewChange,
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
      billingConcurrencySubscriptionContract.confirmChange,
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

    const buyButton = getButtonByText("Buy $200/month");
    click(buyButton);

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review concurrency change",
    });
    expect(buyButton).toHaveTextContent("Updating...");
    expect(buyButton).toBeDisabled();
    expect(checkoutQuantity).toBeNull();
    expect(previewedSubscriptionId).toBe("sub_concurrency_active");
    expect(previewedQuantity).toBe(4);
    expect(within(reviewDialog).getByText("$43.21")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$400.00/month")).toBeInTheDocument();

    click(within(reviewDialog).getByText("Pay and update"));

    await waitFor(() => {
      expect(confirmedSubscriptionId).toBe("sub_concurrency_active");
      expect(confirmedQuantity).toBe(4);
      expect(window.location.href).toBe(
        "https://invoice.stripe.test/queue-concurrency-change",
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
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
    context.mocks.api(runsQueueContract.getQueue, ({ respond }) => {
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
