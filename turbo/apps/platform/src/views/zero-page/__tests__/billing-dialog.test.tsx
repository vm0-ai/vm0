import { describe, it, expect } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
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
