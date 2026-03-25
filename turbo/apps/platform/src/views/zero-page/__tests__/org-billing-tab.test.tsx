import { describe, it, expect } from "vitest";
import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
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

async function openBillingTab() {
  await setupPage({
    context,
    path: "/?settings=billing",
    featureSwitches: { [FeatureSwitchKey.Pricing]: true },
  });
  await waitFor(
    () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
  // Wait for billing tab content to render (the Plan section heading)
  await waitFor(
    () => {
      expect(
        screen.getByText("Manage your plan and payment method."),
      ).toBeInTheDocument();
    },
    { timeout: 5000 },
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
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return HttpResponse.json({
          url: "https://billing.stripe.com/test-portal",
        });
      }),
    );

    await openBillingTab();

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
    await act(async () => {
      fireEvent.click(manageBillingButton);
    });

    // BUG: After clicking "Manage billing", the add-on "Add" buttons should NOT
    // be in loading state. Only the clicked button should show loading.
    // Currently all buttons share billingDialogLoading$ so they all spin.
    for (const addButton of addButtons) {
      expect(addButton).not.toBeDisabled();
    }
  });

  it("should only show loading on 'Manage' button, not on 'Manage billing' or add-on buttons", async () => {
    mockAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    server.use(
      http.post("*/api/zero/billing/portal", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return HttpResponse.json({
          url: "https://billing.stripe.com/test-portal",
        });
      }),
    );

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    // Click the "Manage" button (the second manage button with external link)
    const manageButton = screen.getByRole("button", { name: /^Manage$/i });
    await act(async () => {
      fireEvent.click(manageButton);
    });

    // BUG: The "Manage billing" button should NOT be in loading state
    const manageBillingButton = screen.getByRole("button", {
      name: /Manage billing/i,
    });
    expect(manageBillingButton).not.toBeDisabled();

    // BUG: The add-on "Add" buttons should NOT be in loading state
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

    // BUG: The "Credits" add-on in the add-ons section should NOT be visible
    // because creditAddOn feature switch is not enabled.
    // Credits currently only support auto-recharge, not standalone purchases.
    // The add-on section should say "Credits" — look for the add-on row specifically.
    const addonsHeading = screen.getByText("Add-ons");
    const addonsSection = addonsHeading.closest("section");
    expect(addonsSection).not.toBeNull();

    // Look for text "Credits" within the add-on card section (not the sidebar nav)
    const allCreditsTexts = screen.getAllByText("Credits");
    // Filter to only those inside the add-ons section
    const creditsInAddonSection = allCreditsTexts.filter((el) =>
      addonsSection!.contains(el),
    );
    expect(creditsInAddonSection).toHaveLength(0);
  });
});
