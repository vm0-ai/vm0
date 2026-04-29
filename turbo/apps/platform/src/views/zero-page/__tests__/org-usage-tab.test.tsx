import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import {
  setMockUsageMembers,
  resetMockUsageMembers,
} from "../../../mocks/handlers/api-usage.ts";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";
import { zeroMemberCreditCapContract } from "@vm0/api-contracts/contracts/zero-member-credit-cap";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

interface MockMember {
  userId: string;
  email: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  creditsCharged: number;
  creditCap: number | null;
}

beforeEach(() => {
  resetMockUsageMembers();
});

function setupMockAPIs(members: MockMember[]) {
  const capStore: Record<string, number | null> = {};
  for (const m of members) {
    capStore[m.userId] = m.creditCap;
  }

  setMockUsageMembers({
    period: { start: "2026-03-01", end: "2026-03-31" },
    members: members.map((m) => {
      return { ...m, creditCap: capStore[m.userId] ?? m.creditCap };
    }),
  });

  // Override credit-cap PUT to track changes and reflect in usage response
  server.use(
    mockApi(zeroMemberCreditCapContract.set, ({ body, respond }) => {
      capStore[body.userId] = body.creditCap;
      // Update the usage members mock to reflect the new cap
      setMockUsageMembers({
        period: { start: "2026-03-01", end: "2026-03-31" },
        members: members.map((m) => {
          return { ...m, creditCap: capStore[m.userId] ?? m.creditCap };
        }),
      });
      return respond(200, {
        userId: body.userId,
        creditCap: body.creditCap,
        creditEnabled: true,
      });
    }),
  );

  return capStore;
}

async function openUsageTab() {
  detachedSetupPage({ context, path: "/?settings=usage" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(
      screen.getByText(
        "Credit balance and per-member credit consumption this billing period.",
      ),
    ).toBeInTheDocument();
  });
}

describe("org usage tab - credit balance display", () => {
  it("should show credit balance for pro plan", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 15_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    setupMockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 5000,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      const info = screen.getByTestId("credit-balance-info");
      expect(info).toHaveTextContent("15,000");
    });
  });

  it("should show credit addition records with expiry on hover", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    setMockBillingStatus({
      tier: "pro",
      credits: 35_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      creditBreakdown: [
        { category: "plan", label: "Pro plan", credits: 15_000, tier: "pro" },
        { category: "payAsYouGo", label: "Pay as you go", credits: 20_000 },
      ],
      creditGrants: [
        {
          id: "grant-pro",
          source: "subscription_renewal",
          label: "Pro plan",
          amount: 20_000,
          remaining: 15_000,
          createdAt: "2026-03-20T00:00:00.000Z",
          expiresAt: "2026-04-20T00:00:00.000Z",
        },
        {
          id: "grant-payg",
          source: "auto_recharge",
          label: "Pay as you go",
          amount: 20_000,
          remaining: 20_000,
          createdAt: "2026-03-25T00:00:00.000Z",
          expiresAt: "2999-12-31T00:00:00.000Z",
        },
      ],
    });

    setupMockAPIs([]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("Credit additions")).toBeInTheDocument();
      expect(screen.getByTestId("credit-grants-section")).not.toHaveAttribute(
        "open",
      );
    });

    await user.click(screen.getByTestId("credit-grants-toggle"));
    expect(screen.getByTestId("credit-grants-section")).toHaveAttribute("open");

    await waitFor(() => {
      expect(screen.getByTestId("credit-grant-grant-pro")).toHaveTextContent(
        "Pro plan",
      );
      expect(screen.getByTestId("credit-grant-grant-pro")).toHaveTextContent(
        "15,000 left",
      );
    });

    await user.hover(screen.getByTestId("credit-grant-grant-pro"));
    await waitFor(() => {
      expect(
        screen.getAllByText("Expires Apr 20, 2026").length,
      ).toBeGreaterThan(0);
    });

    await user.click(screen.getByTestId("credit-grants-toggle"));
    expect(screen.getByTestId("credit-grants-section")).not.toHaveAttribute(
      "open",
    );
  });

  it("should show non-expiring credit additions on hover", async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    });
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      creditBreakdown: [
        { category: "payAsYouGo", label: "Pay as you go", credits: 20_000 },
      ],
      creditGrants: [
        {
          id: "grant-payg",
          source: "auto_recharge",
          label: "Pay as you go",
          amount: 20_000,
          remaining: 20_000,
          createdAt: "2026-03-25T00:00:00.000Z",
          expiresAt: "2999-12-31T00:00:00.000Z",
        },
      ],
    });

    setupMockAPIs([]);

    await openUsageTab();

    await user.click(screen.getByTestId("credit-grants-toggle"));
    expect(screen.getByTestId("credit-grant-grant-payg")).toHaveTextContent(
      "Added Mar 25, 2026",
    );
    await user.hover(screen.getByTestId("credit-grant-grant-payg"));
    await waitFor(() => {
      expect(screen.getAllByText("Never expires").length).toBeGreaterThan(0);
    });
  });
});

describe("org usage tab - member usage table", () => {
  it("should show member emails and usage", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    setupMockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 500,
        creditCap: null,
      },
      {
        userId: "user-b",
        email: "bob@example.com",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 1200,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("should show 'No usage yet this period' when no members have usage", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    setupMockAPIs([]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("No usage yet this period")).toBeInTheDocument();
    });
  });
});

describe("org usage tab - inline cap editing", () => {
  it("should allow setting a credit cap via unsaved bar", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    const capStore = setupMockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 500,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    // Find the inline cap input (type=number)
    const capInput = screen.getByPlaceholderText("No limit");
    expect(capInput).toBeInTheDocument();

    // Type a cap value — unsaved bar appears
    await fill(capInput, "5000");

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });

    click(screen.getByTestId("save-button"));

    // Wait for save to complete
    await waitFor(() => {
      expect(capStore["user-a"]).toBe(5000);
    });
  });

  it("should discard cap changes via unsaved bar", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    setupMockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 500,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    const capInput = screen.getByPlaceholderText("No limit");
    await fill(capInput, "3000");

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });

    click(screen.getByTestId("discard-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
    });
  });
});

describe("org usage tab - free tier", () => {
  it("should show credit balance for free tier", async () => {
    setMockBillingStatus({
      tier: "free",
      credits: 8000,
      hasSubscription: false,
    });

    server.use(
      mockApi(zeroUsageMembersContract.get, ({ respond }) => {
        return respond(200, { period: null, members: [] });
      }),
    );

    await openUsageTab();

    await waitFor(() => {
      const info = screen.getByTestId("credit-balance-info");
      expect(info).toHaveTextContent("8,000");
    });
  });

  it("should not show members section for free tier", async () => {
    setMockBillingStatus({
      tier: "free",
      credits: 10_000,
      hasSubscription: false,
    });

    server.use(
      mockApi(zeroUsageMembersContract.get, ({ respond }) => {
        return respond(200, { period: null, members: [] });
      }),
    );

    await openUsageTab();

    await waitFor(() => {
      const info = screen.getByTestId("credit-balance-info");
      expect(info).toHaveTextContent("10,000");
    });

    expect(
      screen.queryByRole("heading", { name: "Members" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/No active billing period/),
    ).not.toBeInTheDocument();
  });
});
