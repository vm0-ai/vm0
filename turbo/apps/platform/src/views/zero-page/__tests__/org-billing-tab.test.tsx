import { describe, it, expect } from "vitest";
import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/chat-threads", () =>
      HttpResponse.json({ threads: [] }),
    ),
    http.get("*/api/zero/team", () =>
      HttpResponse.json([
        {
          id: "mock-compose-id",
          name: "zero",
          displayName: null,
          description: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]),
    ),
    http.get("*/api/zero/org/logo", () => HttpResponse.json({ logoUrl: null })),
  );
}

async function openBillingTab() {
  await setupPage({ context, path: "/?settings=billing" });
  await waitFor(
    () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
}

describe("org billing tab - plan display", () => {
  it("should show Free plan for free tier", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });
  });

  it("should show Pro plan for pro tier", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });
  });

  it("should show Upgrade button for free tier", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /Upgrade/i }),
    ).toBeInTheDocument();
  });

  it("should show Compare all plans link", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    expect(screen.getByText("Compare all plans")).toBeInTheDocument();
  });
});

describe("org billing tab - pricing sub-page navigation", () => {
  it("should navigate to pricing page when clicking Compare all plans", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    await act(() => {
      fireEvent.click(screen.getByText("Compare all plans"));
    });

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    // Should show all three plan cards
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("should navigate back from pricing page via Back button", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    await act(() => {
      fireEvent.click(screen.getByText("Compare all plans"));
    });

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    const backButton = screen.getByRole("button", { name: /Back/i });
    await act(() => {
      fireEvent.click(backButton);
    });

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });
  });

  it("should mark current plan as disabled on pricing page", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    await act(() => {
      fireEvent.click(screen.getByText("Compare all plans"));
    });

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    // The "Current plan" button for the pro plan should be disabled
    const currentPlanButtons = screen.getAllByRole("button", {
      name: /Current plan/i,
    });
    expect(currentPlanButtons.length).toBeGreaterThanOrEqual(1);
    for (const btn of currentPlanButtons) {
      expect(btn).toBeDisabled();
    }
  });
});

describe("org billing tab - auto-recharge section", () => {
  it("should show auto-recharge section for paid plans", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
    expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
  });

  it("should not show auto-recharge section for free plan", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    expect(screen.queryByText("Auto-recharge")).not.toBeInTheDocument();
  });
});
