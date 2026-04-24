import { test, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";
import { setMockOrg, resetMockOrg } from "../../../mocks/handlers/api-org.ts";
import {
  setMockUsageMembers,
  resetMockUsageMembers,
} from "../../../mocks/handlers/api-usage.ts";
import { zeroUsageMembersContract } from "@vm0/core/contracts/zero-usage";
import { zeroMemberCreditCapContract } from "@vm0/core/contracts/zero-member-credit-cap";
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

function makeMember(
  userId: string,
  email: string,
  creditsCharged: number,
  creditCap: number | null = null,
): MockMember {
  return {
    userId,
    email,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    creditsCharged,
    creditCap,
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
      makeMember("user-a", "alice@example.com", 500, null),
      makeMember("user-b", "bob@example.com", 1200, null),
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

// ORG-C-055 (admin case)
test("shows editable credit cap input for admins", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 20_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  setupMockAPIs({
    members: [makeMember("user-a", "alice@example.com", 500, 3000)],
  });
  await openUsageTab();
  await waitFor(() => {
    expect(screen.getByPlaceholderText("No limit")).toBeInTheDocument();
  });
});

// ORG-C-055 (non-admin case)
test("redirects non-admins to general tab when usage tab is requested", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 20_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  setupMockAPIs({
    members: [makeMember("user-a", "alice@example.com", 500, 3000)],
    role: "member",
  });
  detachedSetupPage({ context, path: "/?settings=usage" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  // Non-admins are redirected to general tab; usage tab content is never shown
  await waitFor(() => {
    // No cap input spinbutton is visible
    expect(screen.queryByPlaceholderText("No limit")).not.toBeInTheDocument();
    // Usage tab error/error state is also not present
    expect(screen.queryByTestId("usage-tab-error")).not.toBeInTheDocument();
  });
});

// ORG-I-057
test("credit cap input accepts value and saves via unsaved bar", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 20_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  let capturedCap: number | null = null;
  setupMockAPIs({
    members: [makeMember("user-a", "alice@example.com", 500, null)],
  });
  server.use(
    mockApi(zeroMemberCreditCapContract.set, ({ body, respond }) => {
      capturedCap = body.creditCap;
      return respond(200, {
        userId: body.userId,
        creditCap: body.creditCap,
        creditEnabled: true,
      });
    }),
  );
  await openUsageTab();
  await waitFor(() => {
    expect(screen.getByPlaceholderText("No limit")).toBeInTheDocument();
  });
  const capInput = screen.getByPlaceholderText("No limit");
  await fill(capInput, "5000");
  await waitFor(() => {
    expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
  });
  const saveUser = userEvent.setup({ pointerEventsCheck: 0 });
  await saveUser.click(screen.getByTestId("save-button"));
  await waitFor(() => {
    expect(capturedCap).toBe(5000);
  });
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
