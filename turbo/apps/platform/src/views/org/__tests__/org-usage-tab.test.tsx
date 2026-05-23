import { test, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { setMockOrg, resetMockOrg } from "../../../mocks/handlers/api-org.ts";
import {
  setMockUsageMembers,
  resetMockUsageMembers,
} from "../../../mocks/handlers/api-usage.ts";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";
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
}

function makeMember(
  userId: string,
  email: string,
  creditsCharged: number,
): MockMember {
  return {
    userId,
    email,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    creditsCharged,
  };
}

beforeEach(() => {
  resetMockOrg();
  resetMockUsageMembers();
});

function setupMockAPIs(options?: {
  period?: { start: string; end: string } | null;
  members?: MockMember[];
  errorUsage?: boolean;
  role?: "admin" | "member";
}) {
  const period =
    options?.period !== undefined
      ? options.period
      : { start: "2026-03-01", end: "2026-03-31" };
  const members = options?.members ?? [];
  const role = options?.role ?? "admin";

  setMockOrg({
    id: "org_1",
    slug: "user-12345678",
    name: "User 12345678",
    role,
  });

  if (options?.errorUsage === true) {
    server.use(
      mockApi(zeroUsageMembersContract.get, ({ respond }) => {
        return respond(500, {
          error: { message: "Server error", code: "INTERNAL_SERVER_ERROR" },
        });
      }),
    );
  } else {
    setMockUsageMembers({ period, members });
  }
}

async function openUsageTab() {
  detachedSetupPage({ context, path: "/?settings=usage" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(screen.getByTestId("tab-description")).toBeInTheDocument();
  });
}

// ORG-D-050
test("shows credit balance with formatted numbers in usage tab", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 15_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  setupMockAPIs({ members: [makeMember("user-a", "alice@example.com", 5000)] });
  await openUsageTab();
  await waitFor(() => {
    const info = screen.getByTestId("credit-balance-info");
    expect(info).toHaveTextContent("15,000");
  });
});

// ORG-D-054
test("shows member email and credits in usage list", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 20_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  setupMockAPIs({
    members: [
      makeMember("user-a", "alice@example.com", 500),
      makeMember("user-b", "bob@example.com", 1200),
    ],
  });
  await openUsageTab();
  await waitFor(() => {
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });
  expect(screen.getByText("500")).toBeInTheDocument();
  expect(screen.getByText("1,200")).toBeInTheDocument();
});

// ORG-S-058
test("shows error state when usage API fails in usage tab", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 20_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  setupMockAPIs({ errorUsage: true });
  await openUsageTab();
  await waitFor(() => {
    expect(screen.getByTestId("usage-tab-error")).toBeInTheDocument();
  });
});
