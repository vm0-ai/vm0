import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { zeroCreditCommand } from "../credit";

function buildZeroToken(capabilities: readonly string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user-credit",
      runId: "run-credit",
      orgId: "org-credit",
      scope: "zero",
      capabilities,
      iat: 1000,
      exp: 2000,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function stubMembers(role: "admin" | "member") {
  return http.get("http://localhost:3000/api/zero/org/members", () => {
    return HttpResponse.json({
      slug: "test-org",
      role,
      members: [
        {
          userId: "admin-1",
          email: "admin@example.com",
          firstName: "Admin",
          lastName: "User",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

function stubBillingStatus(
  overrides: {
    readonly tier?: string;
    readonly canBuyCredits?: boolean;
    readonly videoGenerationAllowed?: boolean;
  } = {},
) {
  return http.get("http://localhost:3000/api/zero/billing/status", () => {
    return HttpResponse.json({
      tier: overrides.tier ?? "pro",
      canBuyCredits: overrides.canBuyCredits ?? true,
      videoGenerationAllowed: overrides.videoGenerationAllowed ?? true,
      credits: 12345,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-02-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: {
        enabled: true,
        threshold: 5000,
        amount: 20000,
      },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    });
  });
}

describe("zero credit command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
    server.use(stubBillingStatus());
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  it("shows current credit status without creating checkout", async () => {
    server.use(stubBillingStatus());

    await zeroCreditCommand.parseAsync(["node", "cli"]);

    expect(output()).toContain("Credit status:");
    expect(output()).toContain("Tier: pro");
    expect(output()).toContain("Available credits: 12,345");
    expect(output()).toContain("Auto-recharge: enabled");
    expect(output()).toContain("Threshold: 5,000");
    expect(output()).toContain("Amount: 20,000");
    expect(output()).toContain("Can purchase credits: yes");
    expect(output()).toContain("Built-in video generation: available");
  });

  it("guides non-admins to zero doctor credit", async () => {
    server.use(stubMembers("member"));

    await zeroCreditCommand.parseAsync(["node", "cli", "20000"]);

    expect(output()).toContain("zero doctor credit");
  });

  it("creates a credit checkout link for admins", async () => {
    let capturedBody: unknown = null;
    server.use(
      stubMembers("admin"),
      http.post(
        "http://localhost:3000/api/zero/billing/credit-checkout",
        async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            url: "https://checkout.stripe.com/session/credit",
          });
        },
      ),
    );

    await zeroCreditCommand.parseAsync([
      "node",
      "cli",
      "20000",
      "--auto-recharge",
      "--auto-recharge-threshold",
      "5000",
      "--auto-recharge-amount",
      "20000",
    ]);

    expect(capturedBody).toMatchObject({
      credits: 20_000,
      autoRecharge: {
        enabled: true,
        threshold: 5000,
        amount: 20_000,
      },
    });
    expect(output()).toContain("https://checkout.stripe.com/session/credit");
  });

  it("routes plans that cannot buy credits to the upgrade link", async () => {
    let checkoutRequests = 0;
    server.use(
      stubMembers("admin"),
      stubBillingStatus({
        tier: "limited-free-1",
        canBuyCredits: false,
        videoGenerationAllowed: false,
      }),
      http.post(
        "http://localhost:3000/api/zero/billing/credit-checkout",
        () => {
          checkoutRequests += 1;
          return HttpResponse.json({
            url: "https://checkout.stripe.com/should-not-open",
          });
        },
      ),
    );

    await zeroCreditCommand.parseAsync(["node", "cli", "20000"]);

    expect(output()).toContain(
      "Credit purchases are not available for this workspace plan.",
    );
    expect(output()).toContain(
      "http://localhost:3000/?settings=billing&billingView=plans",
    );
    expect(checkoutRequests).toBe(0);
  });

  it("rejects auto-recharge threshold without the auto-recharge flag", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    server.use(stubMembers("admin"));

    try {
      await zeroCreditCommand.parseAsync([
        "node",
        "cli",
        "20000",
        "--auto-recharge-threshold",
        "5000",
        "--auto-recharge-amount",
        "20000",
      ]);

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain(
        "--auto-recharge-threshold and --auto-recharge-amount require --auto-recharge",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("rejects zero-token credit status without billing:read", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(["billing:write"]));

    try {
      await zeroCreditCommand.parseAsync(["node", "cli"]);

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain(
        "checking credit status requires billing:read capability",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("rejects zero-token credit checkout without billing:write", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(["billing:read"]));

    try {
      await zeroCreditCommand.parseAsync(["node", "cli", "20000"]);

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain(
        "buying credits requires billing:write capability",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });
});
