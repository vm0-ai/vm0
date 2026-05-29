import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { zeroCreditCommand } from "../credit";

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

describe("zero credit command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

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
});
