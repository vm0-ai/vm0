import { describe, it, expect } from "vitest";
import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import { http, HttpResponse, delay } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { FeatureSwitchKey } from "@vm0/core";

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

describe("org billing tab - loading state isolation", () => {
  it("should only show loading on 'Manage billing' button, not on add-on buttons when clicking Manage billing", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    // Make the portal endpoint slow so we can observe loading state
    server.use(
      http.post("*/api/zero/billing/portal", async () => {
        await delay("infinite");
        return HttpResponse.json({
          url: "https://billing.stripe.com/test-portal",
        });
      }),
    );

    await setupPage({
      context,
      path: "/?settings=billing",
      featureSwitches: {
        [FeatureSwitchKey.Pricing]: true,
        [FeatureSwitchKey.ConcurrentAddOn]: true,
        [FeatureSwitchKey.CreditAddOn]: true,
      },
    });
    await waitFor(
      () => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    await waitFor(
      () => {
        expect(
          screen.getByText("Manage your plan and payment method."),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Wait for billing data to load (shows "Pro plan")
    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    // There should be a "Manage billing" button and a "Manage" button,
    // plus two "Add" buttons for the add-on section
    const addButtons = screen.getAllByRole("button", { name: /^Add$/i });
    expect(addButtons.length).toBeGreaterThanOrEqual(2);

    // Click the "Manage billing" button (the first one with external link)
    const manageBillingButton = screen.getByRole("button", {
      name: /Manage billing/i,
    });
    await act(() => {
      fireEvent.click(manageBillingButton);
    });

    // BUG: After clicking "Manage billing", the add-on "Add" buttons should NOT
    // be in loading state. Only the clicked button should show loading.
    // Currently all buttons share billingDialogLoading$ so they all spin.
    for (const addButton of addButtons) {
      expect(addButton).not.toBeDisabled();
    }
  });

  it("should not show loading on add-on buttons when clicking 'Manage' portal button", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    server.use(
      http.post("*/api/zero/billing/portal", async () => {
        await delay("infinite");
        return HttpResponse.json({
          url: "https://billing.stripe.com/test-portal",
        });
      }),
    );

    await setupPage({
      context,
      path: "/?settings=billing",
      featureSwitches: {
        [FeatureSwitchKey.Pricing]: true,
        [FeatureSwitchKey.ConcurrentAddOn]: true,
        [FeatureSwitchKey.CreditAddOn]: true,
      },
    });
    await waitFor(
      () => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    await waitFor(
      () => {
        expect(
          screen.getByText("Manage your plan and payment method."),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    // Click the "Manage" button (the second manage button with external link)
    const manageButton = screen.getByRole("button", { name: /^Manage$/i });
    await act(() => {
      fireEvent.click(manageButton);
    });

    // The add-on "Add" buttons should NOT be in loading state
    const addButtons = screen.getAllByRole("button", { name: /^Add$/i });
    for (const addButton of addButtons) {
      expect(addButton).not.toBeDisabled();
    }
  });
});

describe("org billing tab - add-on visibility", () => {
  it("should hide concurrent agent add-on when concurrentAddOn feature switch is off", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await setupPage({
      context,
      path: "/?settings=billing",
      featureSwitches: {
        [FeatureSwitchKey.Pricing]: true,
      },
    });

    await waitFor(
      () => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    // BUG: The "Active agent" add-on should NOT be visible because
    // concurrentAddOn feature switch is not enabled.
    // It should be gated behind a dedicated feature switch.
    expect(screen.queryByText("Active agent")).not.toBeInTheDocument();
  });

  it("should hide credits add-on when creditAddOn feature switch is off", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    // Enable concurrentAddOn but NOT creditAddOn so the Add-ons section
    // is visible but Credits row should be absent.
    await setupPage({
      context,
      path: "/?settings=billing",
      featureSwitches: {
        [FeatureSwitchKey.Pricing]: true,
        [FeatureSwitchKey.ConcurrentAddOn]: true,
      },
    });

    await waitFor(
      () => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    // The Add-ons section should be visible (concurrentAddOn is on)
    const addonsHeading = screen.getByText("Add-ons");
    const addonsSection = addonsHeading.closest("section");
    expect(addonsSection).not.toBeNull();

    // "Active agent" add-on should be visible
    expect(screen.getByText("Active agent")).toBeInTheDocument();

    // The Credits add-on row should NOT be visible because
    // creditAddOn feature switch is not enabled.
    const allCreditsTexts = screen.queryAllByText("Credits");
    const creditsInAddonSection = allCreditsTexts.filter((el) =>
      addonsSection!.contains(el),
    );
    expect(creditsInAddonSection).toHaveLength(0);
  });
});
