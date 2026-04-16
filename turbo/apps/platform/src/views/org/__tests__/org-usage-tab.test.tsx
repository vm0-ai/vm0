import { test, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { setMockBillingStatus } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

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

function mockAPIs(options?: {
  period?: { start: string; end: string } | null;
  members?: MockMember[];
  errorUsage?: boolean;
  role?: string;
}) {
  const period =
    options?.period !== undefined
      ? options.period
      : { start: "2026-03-01", end: "2026-03-31" };
  const members = options?.members ?? [];
  const role = options?.role ?? "admin";

  server.use(
    http.get("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "user-12345678",
        name: "User 12345678",
        role,
      });
    }),
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
    http.get("*/api/zero/org/members", () => {
      return HttpResponse.json({
        members: [],
        pendingInvitations: [],
        membershipRequests: [],
      });
    }),
    http.get("*/api/zero/usage/members", () => {
      if (options?.errorUsage === true) {
        return HttpResponse.json(
          {
            error: {
              message: "Server error",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 500 },
        );
      }
      return HttpResponse.json({ period, members });
    }),
    http.put("*/api/zero/org/members/credit-cap", async ({ request }) => {
      await request.json();
      return HttpResponse.json({ ok: true });
    }),
  );
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
  mockAPIs({ members: [makeMember("user-a", "alice@example.com", 5000)] });
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
  mockAPIs({
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
  mockAPIs({ members: [makeMember("user-a", "alice@example.com", 500, 3000)] });
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
  mockAPIs({
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
  mockAPIs({ members: [makeMember("user-a", "alice@example.com", 500, null)] });
  server.use(
    http.put("*/api/zero/org/members/credit-cap", async ({ request }) => {
      const body = (await request.json()) as {
        userId: string;
        creditCap: number | null;
      };
      capturedCap = body.creditCap;
      return HttpResponse.json({ ok: true });
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
  mockAPIs({ errorUsage: true });
  await openUsageTab();
  await waitFor(() => {
    expect(screen.getByTestId("usage-tab-error")).toBeInTheDocument();
  });
});
