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
}

function mockAPIs(members: MockMember[]) {
  const capStore: Record<string, number | null> = {};

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
      return HttpResponse.json({
        period: { start: "2026-03-01", end: "2026-03-31" },
        members,
      });
    }),
    http.get("*/api/zero/org/members/credit-cap", ({ request }) => {
      const url = new URL(request.url);
      const userId = url.searchParams.get("userId");
      const cap = userId ? (capStore[userId] ?? null) : null;
      return HttpResponse.json({
        userId,
        creditCap: cap,
        creditEnabled: cap !== null,
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

async function openCreditsTab() {
  await setupPage({
    context,
    path: "/?settings=credits",
  });
  await waitFor(
    () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
  // Wait for credits tab content to render (the Usage heading)
  await waitFor(
    () => {
      expect(
        screen.getByText("Track your credit usage and remaining balance."),
      ).toBeInTheDocument();
    },
    { timeout: 5000 },
  );
}

describe("org credits tab - member cap re-edit", () => {
  it("should allow clicking the cap number to open edit mode after a cap has been previously set", async () => {
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
      },
    ]);

    await openCreditsTab();

    // Wait for member list to appear
    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    // Initially the cap should show "No limit" (clickable button)
    const noLimitButton = screen.getByText("No limit");
    expect(noLimitButton).toBeInTheDocument();

    // Click to enter edit mode
    await act(() => {
      fireEvent.click(noLimitButton);
    });

    // Should see an input field now
    await waitFor(() => {
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });

    // Type a cap value
    const input = screen.getByRole("spinbutton");
    await act(() => {
      fireEvent.change(input, { target: { value: "5000" } });
    });

    // Click Save
    const saveButton = screen.getByRole("button", { name: "Save" });
    await act(() => {
      fireEvent.click(saveButton);
    });

    // Wait for save to complete and edit mode to close
    // The cap should now show "5,000" as a clickable button
    await waitFor(
      () => {
        expect(screen.getByText("5,000")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // BUG: After setting the cap once, clicking the cap number should open
    // edit mode again. Currently this fails because the new MemberCapSetting
    // created after re-fetch may not properly allow re-entering edit mode.
    const capButton = screen.getByText("5,000");
    await act(() => {
      fireEvent.click(capButton);
    });

    // Should see the input field again with the current cap value
    await waitFor(() => {
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });

    // The input should have the current cap value pre-filled
    const editInput = screen.getByRole("spinbutton");
    expect(editInput).toHaveValue(5000);
  });

  it("should allow editing the cap multiple times in succession", async () => {
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
      },
    ]);

    await openCreditsTab();

    // Wait for member list to appear
    await waitFor(() => {
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    });

    // First edit: set cap to 3000
    const noLimitButton = screen.getByText("No limit");
    await act(() => {
      fireEvent.click(noLimitButton);
    });

    let input = screen.getByRole("spinbutton");
    await act(() => {
      fireEvent.change(input, { target: { value: "3000" } });
    });

    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    await waitFor(
      () => {
        expect(screen.getByText("3,000")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Second edit: change cap from 3000 to 7000
    const capButton3000 = screen.getByText("3,000");
    await act(() => {
      fireEvent.click(capButton3000);
    });

    await waitFor(() => {
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });

    input = screen.getByRole("spinbutton");
    await act(() => {
      fireEvent.change(input, { target: { value: "7000" } });
    });

    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    // Should show 7,000 after second save
    await waitFor(
      () => {
        expect(screen.getByText("7,000")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // Third attempt: should still be able to click to edit
    const capButton7000 = screen.getByText("7,000");
    await act(() => {
      fireEvent.click(capButton7000);
    });

    await waitFor(() => {
      expect(screen.getByRole("spinbutton")).toBeInTheDocument();
    });
  });
});
