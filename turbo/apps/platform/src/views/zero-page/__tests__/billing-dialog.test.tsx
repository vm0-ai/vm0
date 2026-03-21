import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

describe("billing in sidebar", () => {
  it("should not show billing button when pricing feature is disabled", async () => {
    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: false },
    });

    expect(screen.queryByText("Free")).not.toBeInTheDocument();
  });

  it("should show tier and credits in sidebar when pricing feature is enabled", async () => {
    setMockBillingStatus({ tier: "free", credits: 2000 });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText(
      "free",
      {},
      { timeout: 3000 },
    );
    expect(billingButton).toBeInTheDocument();
    expect(screen.getByText("2,000")).toBeInTheDocument();
  });

  it("should show max tier with correct credits", async () => {
    setMockBillingStatus({ tier: "max", credits: 82_000 });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText("max", {}, { timeout: 3000 });
    expect(billingButton).toBeInTheDocument();
    expect(screen.getByText("82,000")).toBeInTheDocument();
  });

  it("should open billing dialog when clicking billing button", async () => {
    setMockBillingStatus({ tier: "free", credits: 2000 });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText(
      "free",
      {},
      { timeout: 3000 },
    );
    await act(() => {
      fireEvent.click(billingButton);
    });

    await expect(
      screen.findByText("Choose your plan"),
    ).resolves.toBeInTheDocument();
  });

  it("should highlight current plan in dialog", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText("pro", {}, { timeout: 3000 });
    await act(() => {
      fireEvent.click(billingButton);
    });

    await screen.findByText("Choose your plan");
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("should show upgrade button when free user selects pro", async () => {
    setMockBillingStatus({ tier: "free", credits: 2000 });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText(
      "free",
      {},
      { timeout: 3000 },
    );
    await act(() => {
      fireEvent.click(billingButton);
    });

    await screen.findByText("Choose your plan");

    // Find the Pro plan card and click it
    const proPlanCard = screen.getByText("$29").closest("button");
    expect(proPlanCard).toBeTruthy();
    await act(() => {
      fireEvent.click(proPlanCard!);
    });

    expect(screen.getByText("Upgrade to Pro")).toBeInTheDocument();
  });

  it("should show manage subscription button when pro user selects free", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText("pro", {}, { timeout: 3000 });
    await act(() => {
      fireEvent.click(billingButton);
    });

    await screen.findByText("Choose your plan");

    // Click free plan
    const freePlanCard = screen.getByText("$0").closest("button");
    expect(freePlanCard).toBeTruthy();
    await act(() => {
      fireEvent.click(freePlanCard!);
    });

    expect(screen.getByText("Manage subscription")).toBeInTheDocument();
  });

  it("should show manage subscription when max user selects pro (downgrade)", async () => {
    setMockBillingStatus({
      tier: "max",
      credits: 80_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText("max", {}, { timeout: 3000 });
    await act(() => {
      fireEvent.click(billingButton);
    });

    await screen.findByText("Choose your plan");

    // Click pro plan
    const proPlanCard = screen.getByText("$29").closest("button");
    expect(proPlanCard).toBeTruthy();
    await act(() => {
      fireEvent.click(proPlanCard!);
    });

    expect(screen.getByText("Manage subscription")).toBeInTheDocument();
  });

  it("should not show action button when current plan is selected", async () => {
    setMockBillingStatus({ tier: "free", credits: 2000 });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText(
      "free",
      {},
      { timeout: 3000 },
    );
    await act(() => {
      fireEvent.click(billingButton);
    });

    await screen.findByText("Choose your plan");

    // Free plan is already selected (current), so no action button
    expect(screen.queryByText("Upgrade to Free")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage subscription")).not.toBeInTheDocument();
  });

  it("should show correct description with credits", async () => {
    setMockBillingStatus({
      tier: "max",
      credits: 82_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText("max", {}, { timeout: 3000 });
    await act(() => {
      fireEvent.click(billingButton);
    });

    await expect(
      screen.findByText(/You are on the Max plan with 82,000 credits/),
    ).resolves.toBeInTheDocument();
  });
});

describe("auto-recharge in billing dialog", () => {
  async function openBillingDialog(tier: "free" | "pro" | "max") {
    await setupPage({
      context,
      path: "/works",
      featureSwitches: { [FeatureSwitchKey.Pricing]: true },
    });

    const billingButton = await screen.findByText(tier, {}, { timeout: 3000 });
    await act(() => {
      fireEvent.click(billingButton);
    });

    await screen.findByText("Choose your plan");
  }

  it("should not show auto-recharge section for free tier", async () => {
    setMockBillingStatus({
      tier: "free",
      credits: 2000,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingDialog("free");

    expect(screen.queryByText("Auto-recharge")).not.toBeInTheDocument();
  });

  it("should show auto-recharge section for pro tier", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingDialog("pro");

    expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
  });

  it("should show auto-recharge section for max tier", async () => {
    setMockBillingStatus({
      tier: "max",
      credits: 80_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingDialog("max");

    expect(screen.getByText("Auto-recharge")).toBeInTheDocument();
  });

  it("should show threshold and amount inputs when auto-recharge is toggled on", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingDialog("pro");

    // Toggle auto-recharge on
    const toggle = screen.getByRole("switch");
    await act(() => {
      fireEvent.click(toggle);
    });

    expect(screen.getByText("When credits drop below")).toBeInTheDocument();
    expect(screen.getByText("Recharge amount")).toBeInTheDocument();
  });

  it("should display dollar amount preview for recharge input", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 10_000 },
    });

    await openBillingDialog("pro");

    // $10.00 for 10,000 credits ($1 = 1,000 credits)
    expect(screen.getByText("= $10.00")).toBeInTheDocument();
  });

  it("should send correct PUT body when enabling auto-recharge via Save", async () => {
    const requestBody = vi.fn();
    server.use(
      http.put("*/api/billing/auto-recharge", async ({ request }) => {
        requestBody(await request.json());
        return HttpResponse.json({
          enabled: true,
          threshold: 2000,
          amount: 5000,
        });
      }),
    );

    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });

    await openBillingDialog("pro");

    // Toggle on
    const toggle = screen.getByRole("switch");
    await act(() => {
      fireEvent.click(toggle);
    });

    // Fill in threshold and amount
    const inputs = screen.getAllByRole("spinbutton");
    await act(() => {
      fireEvent.change(inputs[0]!, { target: { value: "2000" } });
      fireEvent.change(inputs[1]!, { target: { value: "5000" } });
    });

    // Click Save
    await act(() => {
      fireEvent.click(screen.getByText("Save"));
    });

    // Verify PUT request was sent with correct body
    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        enabled: true,
        threshold: 2000,
        amount: 5000,
      });
    });
  });

  it("should send enabled:false when disabling auto-recharge via Save", async () => {
    const requestBody = vi.fn();
    server.use(
      http.put("*/api/billing/auto-recharge", async ({ request }) => {
        requestBody(await request.json());
        return HttpResponse.json({
          enabled: false,
          threshold: null,
          amount: null,
        });
      }),
    );

    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 5000 },
    });

    await openBillingDialog("pro");

    // Toggle off
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await act(() => {
      fireEvent.click(toggle);
    });

    // Click Save
    await act(() => {
      fireEvent.click(screen.getByText("Save"));
    });

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({ enabled: false });
    });
  });
});
