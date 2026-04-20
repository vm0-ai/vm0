import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.ts";
import { setMockUsageInsight } from "../../../mocks/handlers/api-usage-insight.ts";
import { resetAllMockHandlers } from "../../../mocks/handlers/index.ts";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

beforeEach(() => {
  resetAllMockHandlers();
});

describe("org usage tab — usage insight view", () => {
  it("renders UsageInsightView when usageAnalytics feature switch is on", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 10_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    setMockFeatureSwitches({ [FeatureSwitchKey.UsageAnalytics]: true });
    setMockUsageInsight({
      buckets: [
        {
          ts: "2026-04-13 00:00:00",
          series: { chat: 500, slack: 200 },
          tokens: { chat: 1000, slack: 400 },
        },
      ],
      schedules: [
        {
          scheduleId: "s1",
          scheduleName: "My Schedule",
          credits: 300,
          tokens: 600,
        },
      ],
      chats: [
        {
          threadId: "t1",
          threadTitle: "Chat with Agent",
          credits: 200,
          tokens: 400,
        },
      ],
      emailCredits: 100,
      emailTokens: 200,
      slackCredits: 200,
      slackTokens: 400,
      grandTotalCredits: 1300,
      grandTotalTokens: 2600,
    });

    detachedSetupPage({ context, path: "/?settings=usage" });

    await waitFor(() => {
      expect(screen.getByText("Usage Insights")).toBeInTheDocument();
    });

    // Detail sections render
    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });
    expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
  });

  it("shows OverviewSection (credit balance) when usageAnalytics is disabled", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 8000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    setMockFeatureSwitches({ [FeatureSwitchKey.UsageAnalytics]: false });

    detachedSetupPage({ context, path: "/?settings=usage" });

    // OverviewSection shows credit balance, not the Usage Insights heading
    await waitFor(() => {
      const info = screen.getByTestId("credit-balance-info");
      expect(info).toHaveTextContent("8,000");
    });

    expect(screen.queryByText("Usage Insights")).not.toBeInTheDocument();
  });
});
