import { describe, it, expect } from "vitest";
import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
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

function mockAPIs(members: MockMember[]) {
  const capStore: Record<string, number | null> = {};
  for (const m of members) {
    capStore[m.userId] = m.creditCap;
  }

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
    http.get("*/api/zero/usage/members", () => {
      // Return members with current cap values from capStore
      const updatedMembers = members.map((m) => ({
        ...m,
        creditCap: capStore[m.userId] ?? m.creditCap,
      }));
      return HttpResponse.json({
        period: { start: "2026-03-01", end: "2026-03-31" },
        members: updatedMembers,
      });
    }),
    http.put("*/api/zero/org/members/credit-cap", async ({ request }) => {
      const body = (await request.json()) as {
        userId: string;
        creditCap: number | null;
      };
      capStore[body.userId] = body.creditCap;
      return HttpResponse.json({ ok: true });
    }),
  );

  return capStore;
}

async function openUsageTab() {
  await setupPage({ context, path: "/?settings=usage" });
  await waitFor(
    () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
  await waitFor(
    () => {
      expect(
        screen.getByText(
          "Credit balance and per-member credit consumption this billing period.",
        ),
      ).toBeInTheDocument();
    },
    { timeout: 5000 },
  );
}

describe("org usage tab - credit balance display", () => {
  it("should show credit balance for pro plan", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 15_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    mockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 5000,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("15,000 credits")).toBeInTheDocument();
    });
  });

  it("should show credit usage bar", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 15_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    mockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 5000,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    });
  });
});

describe("org usage tab - member usage table", () => {
  it("should show member emails and usage", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    mockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 500,
        creditCap: null,
      },
      {
        userId: "user-b",
        email: "bob@example.com",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 1200,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });

  it("should show 'No usage yet this period' when no members have usage", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    mockAPIs([]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("No usage yet this period")).toBeInTheDocument();
    });
  });
});

describe("org usage tab - inline cap editing", () => {
  it("should allow setting a credit cap via inline input", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    const capStore = mockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 500,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    // Find the inline cap input (type=number)
    const capInput = screen.getByRole("spinbutton");
    expect(capInput).toBeInTheDocument();

    // Type a cap value and commit by blurring
    await act(() => {
      fireEvent.change(capInput, { target: { value: "5000" } });
    });
    await act(() => {
      fireEvent.blur(capInput);
    });

    // Wait for save to complete
    await waitFor(
      () => {
        expect(capStore["user-a"]).toBe(5000);
      },
      { timeout: 3000 },
    );
  });

  it("should allow committing cap via Enter key", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });

    const capStore = mockAPIs([
      {
        userId: "user-a",
        email: "alice@example.com",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        creditsCharged: 500,
        creditCap: null,
      },
    ]);

    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    const capInput = screen.getByRole("spinbutton");
    await act(() => {
      fireEvent.change(capInput, { target: { value: "3000" } });
    });
    await act(() => {
      fireEvent.keyDown(capInput, { key: "Enter" });
    });

    await waitFor(
      () => {
        expect(capStore["user-a"]).toBe(3000);
      },
      { timeout: 3000 },
    );
  });
});
