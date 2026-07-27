import { screen, waitFor } from "@testing-library/react";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";
import type { QueueEntry } from "@vm0/api-contracts/contracts/runs";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const THREAD_ID = "thread-queue";

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
  concurrency?: {
    tier: "free" | "pro-suspend" | "pro" | "team" | "custom";
    limit: number;
    active: number;
    available: number;
  };
  queue?: QueueEntry[];
}) {
  return {
    concurrency: overrides?.concurrency ?? {
      tier: "free" as const,
      limit: 1,
      active: 1,
      available: 0,
    },
    queue: overrides?.queue ?? [],
    runningTasks: [],
    estimatedTimePerRun: null,
  };
}

function mockConcurrencyCapability(canBuyConcurrency: boolean): void {
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
    concurrencySubscriptions: [],
  };
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, status);
  });
}

function mockQueuedThread(): void {
  context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
    if (query.sinceSeqId) {
      return respond(200, { messages: [] });
    }

    return respond(200, {
      messages: [
        {
          id: "msg-previous-user",
          role: "user",
          content: "Previous prompt",
          runId: "run-completed",
          seqId: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "msg-previous-assistant",
          role: "assistant",
          content: "Previous answer",
          runId: "run-completed",
          runLifecycleEvent: "completed",
          seqId: 2,
          createdAt: "2026-01-01T00:00:01Z",
        },
        {
          id: "msg-queued-marker",
          role: "assistant",
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

async function openDrawer(): Promise<void> {
  mockQueuedThread();
  detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });
  const queueButton = await waitFor(() => {
    return getButtonByText("queue...");
  });
  click(queueButton);
}

describe("queue drawer", () => {
  it("shows the free tier limit and upgrade path", async () => {
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
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
          concurrency: { tier: "pro", limit: 2, active: 2, available: 0 },
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
          concurrency: { tier: "team", limit: 5, active: 3, available: 2 },
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
          concurrency: { tier: "custom", limit: 10, active: 10, available: 0 },
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

  it("lets Team admins buy additional concurrency when the queue is full", async () => {
    let checkoutQuantity: number | null = null;
    mockConcurrencyCapability(true);
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "team", limit: 5, active: 5, available: 0 },
          queue: [queuedEntry()],
        }),
      );
    });
    context.mocks.api(
      zeroBillingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        checkoutQuantity = body.quantity;
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
  });

  it("hides additional concurrency checkout when the plan capability is disabled", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    mockConcurrencyCapability(false);
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "team", limit: 5, active: 5, available: 0 },
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
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "pro", limit: 2, active: 2, available: 0 },
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
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    context.mocks.api(zeroRunsQueueContract.getQueue, ({ respond }) => {
      return respond(
        200,
        queueResponse({
          concurrency: { tier: "team", limit: 5, active: 5, available: 0 },
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
