import { describe, it, expect, afterEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { reloadBillingStatus$ } from "../../../signals/zero-page/billing.ts";

const context = testContext();

function mockAPIs() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/org/logo", () => {
      return HttpResponse.json({ logoUrl: null });
    }),
  );
}

async function openBillingTab() {
  detachedSetupPage({ context, path: "/?settings=billing" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
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
      screen.getAllByRole("button").find((el) => {
        return /^Upgrade$/i.test(el.textContent?.trim() ?? "");
      }),
    ).toBeDefined();
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
    const user = userEvent.setup();
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    // Should show all three plan cards
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("should navigate back from pricing page via Back button", async () => {
    const user = userEvent.setup();
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    const backButton = screen.getByLabelText("Back");
    await user.click(backButton);

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });
  });

  it("should mark current plan as disabled on pricing page", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    // The "Current plan" button for the pro plan should be disabled
    const currentPlanButtons = screen.getAllByRole("button").filter((el) => {
      return /Current plan/i.test(el.textContent ?? "");
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

  it("should hydrate form with server auto-recharge config when enabled", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 50_000 },
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
    });

    // Toggle should be on
    const toggle = screen.getByRole("switch", {
      name: /enable auto-recharge/i,
    });
    expect(toggle).toHaveAttribute("data-state", "checked");

    // Threshold and amount inputs should show server values
    const thresholdInput = screen.getByLabelText(
      /credit threshold for auto-recharge/i,
    );
    expect(thresholdInput).toHaveValue(5000);

    const amountInput = screen.getByLabelText(
      /auto-recharge credit amount in credits/i,
    );
    expect(amountInput).toHaveValue(50_000);
  });

  it("should show toggle off when server auto-recharge is disabled", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
    });

    const toggle = screen.getByRole("switch", {
      name: /enable auto-recharge/i,
    });
    expect(toggle).toHaveAttribute("data-state", "unchecked");

    // Threshold and amount inputs should not be visible when disabled
    expect(
      screen.queryByLabelText(/credit threshold for auto-recharge/i),
    ).not.toBeInTheDocument();
  });

  it("should enable toggle when clicked with no prior threshold/amount config", async () => {
    const user = userEvent.setup();
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
    });

    const toggle = screen.getByRole("switch", {
      name: /enable auto-recharge/i,
    });
    expect(toggle).toHaveAttribute("data-state", "unchecked");

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute("data-state", "checked");
    });

    // Inputs should now be visible
    expect(
      screen.getByLabelText(/credit threshold for auto-recharge/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/auto-recharge credit amount in credits/i),
    ).toBeInTheDocument();
  });

  it("should save correct data after enabling toggle with no prior config", async () => {
    const user = userEvent.setup();
    let capturedBody: unknown = null;
    server.use(
      http.put("*/api/zero/billing/auto-recharge", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enabled: true,
          threshold: 2000,
          amount: 10_000,
        });
      }),
    );

    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
    });

    const toggle = screen.getByRole("switch", {
      name: /enable auto-recharge/i,
    });

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute("data-state", "checked");
    });

    // Enter threshold and amount values
    const thresholdInput = screen.getByLabelText(
      /credit threshold for auto-recharge/i,
    );
    const amountInput = screen.getByLabelText(
      /auto-recharge credit amount in credits/i,
    );

    await fill(thresholdInput, "2000");
    await fill(amountInput, "10000");
    amountInput.blur();

    await waitFor(() => {
      expect(capturedBody).toStrictEqual({
        enabled: true,
        threshold: 2000,
        amount: 10_000,
      });
    });
  });

  it("should send correct data when saving auto-recharge config", async () => {
    let capturedBody: unknown = null;
    server.use(
      http.put("*/api/zero/billing/auto-recharge", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enabled: true,
          threshold: 2000,
          amount: 10_000,
        });
      }),
    );

    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 2000, amount: 10_000 },
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
    });

    // Wait for form to hydrate with server values
    const thresholdInput = await waitFor(() => {
      const input = screen.getByLabelText(
        /credit threshold for auto-recharge/i,
      );
      expect(input).toHaveValue(2000);
      return input;
    });

    // Change threshold and blur to trigger save
    await fill(thresholdInput, "3000");
    thresholdInput.blur();

    await waitFor(() => {
      expect(capturedBody).toStrictEqual({
        enabled: true,
        threshold: 3000,
        amount: 10_000,
      });
    });
  });
});

describe("org billing tab - cancellation pending", () => {
  const futureDate = new Date(Date.now() + 30 * 86_400 * 1000).toISOString();

  it("should show cancellation notice when subscription is pending cancellation", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      currentPeriodEnd: futureDate,
      cancelAtPeriodEnd: true,
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(
        screen.getByText(/has been cancelled and will end on/),
      ).toBeInTheDocument();
    });
  });

  it("should show 'Ends on' instead of 'Renews' when cancelling", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      currentPeriodEnd: futureDate,
      cancelAtPeriodEnd: true,
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText(/Ends on/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/Renews/)).not.toBeInTheDocument();
  });

  it("should hide Downgrade button when cancellation is pending", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      currentPeriodEnd: futureDate,
      cancelAtPeriodEnd: true,
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    expect(
      screen.queryAllByRole("button").filter((el) => {
        return el.textContent?.trim() === "Downgrade";
      }),
    ).toHaveLength(0);
  });

  it("should show Manage button when cancellation is pending", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      currentPeriodEnd: futureDate,
      cancelAtPeriodEnd: true,
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    expect(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Manage";
      }),
    ).toBeDefined();
  });

  it("should show normal state when cancelAtPeriodEnd is false", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      currentPeriodEnd: futureDate,
      cancelAtPeriodEnd: false,
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText(/Renews/)).toBeInTheDocument();
    });

    expect(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Downgrade";
      }),
    ).toBeDefined();

    expect(screen.queryByText(/has been cancelled/)).not.toBeInTheDocument();
  });
});

describe("org billing tab - plan card details", () => {
  it("should show plan cards with upgrade buttons on pricing page", async () => {
    const user = userEvent.setup();
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    // Plan cards are rendered for each tier
    expect(
      screen.getAllByRole("button").find((el) => {
        return /Upgrade to Pro/i.test(el.textContent ?? "");
      }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("button").find((el) => {
        return /Upgrade to Team/i.test(el.textContent ?? "");
      }),
    ).toBeDefined();

    // Current plan card shows "Current plan" label
    expect(
      screen.getAllByRole("button").find((el) => {
        return /Current plan/i.test(el.textContent ?? "");
      }),
    ).toBeDefined();
  });
});

describe("org billing tab - renewal date display", () => {
  it("should show renewal date when subscription is active and not cancelling", async () => {
    mockAPIs();
    const futureDate = new Date(Date.now() + 30 * 86_400 * 1000).toISOString();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      currentPeriodEnd: futureDate,
      cancelAtPeriodEnd: false,
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText(/Renews/)).toBeInTheDocument();
    });
  });
});

describe("org billing tab - billing states", () => {
  it("should show error state when billing status fails to load", async () => {
    server.use(
      http.get("*/api/zero/billing/status", () => {
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    mockAPIs();

    await openBillingTab();

    await waitFor(() => {
      expect(
        screen.getByText("Could not load billing status."),
      ).toBeInTheDocument();
    });

    expect(
      screen.getAllByRole("button").find((el) => {
        return /^Retry$/i.test(el.textContent?.trim() ?? "");
      }),
    ).toBeDefined();
  });
});

describe("org billing tab - plan card actions", () => {
  it("should call checkout API when clicking upgrade button on plan card", async () => {
    const user = userEvent.setup();
    let capturedBody: unknown = null;
    server.use(
      http.post("*/api/zero/billing/checkout", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          url: "https://checkout.stripe.com/test?tier=pro",
        });
      }),
    );

    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    const upgradeToProBtn = screen.getAllByRole("button").find((el) => {
      return /Upgrade to Pro/i.test(el.textContent ?? "");
    });
    expect(upgradeToProBtn).toBeDefined();
    await user.click(upgradeToProBtn!);

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ tier: "pro" });
    });
  });
});

describe("org billing tab - stripe portal", () => {
  afterEach(() => {
    if (!window.location.href.startsWith("http://localhost")) {
      window.location.href = "http://localhost/";
    }
  });

  it("should redirect to Stripe portal URL when Manage button is clicked", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("*/api/zero/billing/portal", () => {
        return HttpResponse.json({
          url: "https://billing.stripe.com/test-portal",
        });
      }),
    );

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

    const manageBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Manage";
    });
    expect(manageBtn).toBeDefined();
    await user.click(manageBtn!);

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://billing.stripe.com/test-portal",
      );
    });
  });
});

describe("org billing tab - downgrade flow", () => {
  it("should show Downgrade button for paid tier (pro)", async () => {
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

    expect(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Downgrade";
      }),
    ).toBeDefined();
  });

  it("should show Downgrade button for team tier", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "team",
      credits: 120_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Team plan")).toBeInTheDocument();
    });

    expect(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Downgrade";
      }),
    ).toBeDefined();
  });

  it("should not show Downgrade button for free tier", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    expect(
      screen.queryAllByRole("button").filter((el) => {
        return el.textContent?.trim() === "Downgrade";
      }),
    ).toHaveLength(0);
  });

  it("should open downgrade dialog on Downgrade button click for pro user", async () => {
    const user = userEvent.setup();
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

    const downgradeBtn1 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Downgrade";
    });
    expect(downgradeBtn1).toBeDefined();
    await user.click(downgradeBtn1!);

    await waitFor(() => {
      expect(screen.getByText("Downgrade plan")).toBeInTheDocument();
    });

    // Pro user should see "Downgrade to Free?" confirmation
    expect(
      screen.getByText("Are you sure you want to downgrade to Free?"),
    ).toBeInTheDocument();
  });

  it("should open downgrade dialog with plan selection for team user", async () => {
    const user = userEvent.setup();
    mockAPIs();
    setMockBillingStatus({
      tier: "team",
      credits: 120_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Team plan")).toBeInTheDocument();
    });

    const downgradeBtn2 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Downgrade";
    });
    expect(downgradeBtn2).toBeDefined();
    await user.click(downgradeBtn2!);

    await waitFor(() => {
      expect(screen.getByText("Downgrade plan")).toBeInTheDocument();
    });

    // Team user should see plan selection options
    expect(
      screen.getByText("Choose which plan to downgrade to."),
    ).toBeInTheDocument();
  });

  it("should call downgrade API with correct targetTier on confirm", async () => {
    const user = userEvent.setup();
    let capturedBody: unknown = null;
    server.use(
      http.post("*/api/zero/billing/downgrade", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ success: true, effectiveDate: null });
      }),
    );

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

    const downgradeBtn3 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Downgrade";
    });
    expect(downgradeBtn3).toBeDefined();
    await user.click(downgradeBtn3!);

    await waitFor(() => {
      expect(screen.getByText("Downgrade plan")).toBeInTheDocument();
    });

    const downgradeToFreeBtn = screen.getAllByRole("button").find((el) => {
      return /Downgrade to Free/i.test(el.textContent ?? "");
    });
    expect(downgradeToFreeBtn).toBeDefined();
    await user.click(downgradeToFreeBtn!);

    await waitFor(() => {
      expect(capturedBody).toStrictEqual({ targetTier: "free" });
    });
  });

  it("should close dialog on cancel without calling API", async () => {
    const user = userEvent.setup();
    let apiCalled = false;
    server.use(
      http.post("*/api/zero/billing/downgrade", () => {
        apiCalled = true;
        return HttpResponse.json({ success: true, effectiveDate: null });
      }),
    );

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

    const downgradeBtn4 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Downgrade";
    });
    expect(downgradeBtn4).toBeDefined();
    await user.click(downgradeBtn4!);

    await waitFor(() => {
      expect(screen.getByText("Downgrade plan")).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    const cancelBtn = within(dialog)
      .getAllByRole("button")
      .find((el) => {
        return /^Cancel$/i.test(el.textContent?.trim() ?? "");
      });
    expect(cancelBtn).toBeDefined();
    await user.click(cancelBtn!);

    await waitFor(() => {
      expect(screen.queryByText("Downgrade plan")).not.toBeInTheDocument();
    });

    expect(apiCalled).toBeFalsy();
  });

  it("should route pricing page downgrade through dialog", async () => {
    const user = userEvent.setup();
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

    // Navigate to pricing page
    await user.click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    // Click "Manage subscription" (the downgrade button on pricing page for free tier)
    const manageButtons = screen.getAllByRole("button").filter((el) => {
      return /Manage subscription/i.test(el.textContent ?? "");
    });
    expect(manageButtons.length).toBeGreaterThanOrEqual(1);

    await user.click(manageButtons[0]!);

    // Should open downgrade dialog instead of redirecting to Stripe
    await waitFor(() => {
      expect(screen.getByText("Downgrade plan")).toBeInTheDocument();
    });
  });
});

describe("org billing tab - billing status refresh", () => {
  it("should update plan display when billing status is refreshed", async () => {
    mockAPIs();
    setMockBillingStatus({ tier: "free", credits: 10_000 });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Free plan")).toBeInTheDocument();
    });

    // Simulate upgrade completing: update mock to pro status and trigger reload
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    context.store.set(reloadBillingStatus$);

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    // With useLastLoadable, old data remains during refresh — no flash to skeleton
    expect(screen.queryByText("Free plan")).not.toBeInTheDocument();
  });
});
