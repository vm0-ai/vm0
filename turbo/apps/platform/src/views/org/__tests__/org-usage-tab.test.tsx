import { describe, it, test, expect } from "vitest";
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

async function openUsagePage() {
  detachedSetupPage({ context, path: "/settings/usage" });
  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
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
    expect(screen.getByText("15,000 credits")).toBeInTheDocument();
  });
});

// ORG-D-051
test("shows credit usage bar with aria attributes in usage tab", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 15_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  mockAPIs({ members: [makeMember("user-a", "alice@example.com", 5000)] });
  await openUsageTab();
  await waitFor(() => {
    const bar = screen.getByRole("progressbar");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-valuenow");
  });
});

// ORG-D-052
test("shows used and plan credit text in usage tab", async () => {
  setMockBillingStatus({
    tier: "pro",
    credits: 15_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  mockAPIs({ members: [makeMember("user-a", "alice@example.com", 5000)] });
  await openUsageTab();
  await waitFor(() => {
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("used"),
    );
    expect(bar).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("remaining"),
    );
  });
});

// ORG-D-053
test("shows expiring credits in popover on credit bar hover", async () => {
  const user = userEvent.setup();
  setMockBillingStatus({
    tier: "pro",
    credits: 15_000,
    subscriptionStatus: "active",
    hasSubscription: true,
    creditExpiry: {
      expiringNextCycle: 5000,
      nextExpiryDate: "2026-04-30T00:00:00.000Z",
    },
  });
  mockAPIs({ members: [makeMember("user-a", "alice@example.com", 2000)] });
  await openUsageTab();
  const hoverTarget = screen.getByTestId("credit-bar-hover-target");
  await user.hover(hoverTarget);
  await waitFor(() => {
    expect(screen.getByText(/Expiring on/)).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
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
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
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
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    // Usage tab error/error state is also not present
    expect(screen.queryByTestId("usage-tab-error")).not.toBeInTheDocument();
  });
});

// ORG-I-056
test("hovering credit bar shows breakdown popover", async () => {
  const user = userEvent.setup();
  setMockBillingStatus({
    tier: "pro",
    credits: 15_000,
    subscriptionStatus: "active",
    hasSubscription: true,
  });
  mockAPIs({ members: [makeMember("user-a", "alice@example.com", 2000)] });
  await openUsageTab();
  const hoverTarget = screen.getByTestId("credit-bar-hover-target");
  await user.hover(hoverTarget);
  await waitFor(() => {
    expect(screen.getByText("Credit breakdown")).toBeInTheDocument();
  });
});

// ORG-I-057
test("credit cap input accepts value and updates on blur", async () => {
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
    expect(screen.getByRole("spinbutton")).toBeInTheDocument();
  });
  const capInput = screen.getByRole("spinbutton");
  await fill(capInput, "5000");
  capInput.blur();
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

// ORG-D-115
test("shows formatted period start and end dates in usage page header", async () => {
  mockAPIs({
    period: { start: "2026-03-01", end: "2026-03-31" },
    members: [],
  });
  await openUsagePage();
  await waitFor(() => {
    const allText = document.body.textContent ?? "";
    // Formatted dates should appear (e.g. "Mar 1, 2026") not ISO strings
    expect(allText).toContain("Mar");
    expect(allText).not.toContain("2026-03-01");
    expect(allText).not.toContain("2026-03-31");
  });
});

// ORG-D-116
test("shows email and formatted token counts in usage page member table", async () => {
  mockAPIs({
    period: { start: "2026-03-01", end: "2026-03-31" },
    members: [
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        creditsCharged: 75,
        creditCap: null,
      },
    ],
  });
  await openUsagePage();
  await waitFor(() => {
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("1,000")).toBeInTheDocument();
    // outputTokens (500) and cacheTokens (200+300=500) both display as "500"
    expect(screen.getAllByText("500").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("75")).toBeInTheDocument();
  });
});

// ORG-C-117
describe("usage page states", () => {
  it("shows error state when API fails", async () => {
    mockAPIs({ errorUsage: true });
    await openUsagePage();
    await waitFor(() => {
      expect(screen.getByTestId("usage-page-error")).toBeInTheDocument();
    });
  });

  it("shows no-period empty state", async () => {
    mockAPIs({ period: null, members: [] });
    await openUsagePage();
    await waitFor(() => {
      expect(screen.getByTestId("usage-page-no-period")).toBeInTheDocument();
    });
  });

  it("shows no-members empty state", async () => {
    mockAPIs({
      period: { start: "2026-03-01", end: "2026-03-31" },
      members: [],
    });
    await openUsagePage();
    await waitFor(() => {
      expect(screen.getByTestId("usage-page-no-members")).toBeInTheDocument();
    });
  });

  it("shows data table when members exist", async () => {
    mockAPIs({
      period: { start: "2026-03-01", end: "2026-03-31" },
      members: [makeMember("user-a", "alice@example.com", 100)],
    });
    await openUsagePage();
    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
