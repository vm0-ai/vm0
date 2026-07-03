import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import chalk from "chalk";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { zeroBankingCommand } from "../index";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "zero-banking-home-"));

vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

describe("zero banking command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(async () => {
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(async () => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
  });

  it("posts transaction requests with the default limit and prints JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/banking/transactions",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            operation: "transactions",
            provider: "finicity",
            accountId: "acct-1",
            transactions: [
              {
                id: "txn-1",
                accountId: "acct-1",
                amount: -12.34,
                description: "Coffee",
              },
            ],
          });
        },
      ),
    );

    await zeroBankingCommand.parseAsync([
      "node",
      "cli",
      "transactions",
      "--account-id",
      "acct-1",
      "--from",
      "2026-01-01",
      "--to",
      "2026-01-31",
      "--json",
    ]);

    expect(requestBody).toEqual({
      accountId: "acct-1",
      from: "2026-01-01",
      to: "2026-01-31",
      limit: 100,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        operation: "transactions",
        provider: "finicity",
        accountId: "acct-1",
        transactions: [
          {
            id: "txn-1",
            accountId: "acct-1",
            amount: -12.34,
            description: "Coffee",
          },
        ],
      }),
    );
  });

  it("renders provider and account data in human output", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/banking/accounts", () => {
        return HttpResponse.json({
          operation: "accounts",
          provider: "finicity",
          accounts: [
            {
              id: "acct-1",
              name: "Everyday Checking",
              institutionName: "Example Bank",
              type: "checking",
              last4: "6789",
            },
          ],
        });
      }),
    );

    await zeroBankingCommand.parseAsync(["node", "cli", "accounts"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Banking accounts loaded");
    expect(output).toContain("Provider: finicity");
    expect(output).toContain("Everyday Checking");
    expect(output).toContain("Example Bank");
  });

  it("shows auth guidance when no token is available", async () => {
    vi.stubEnv("ZERO_TOKEN", undefined);
    vi.stubEnv("VM0_TOKEN", undefined);

    await expect(
      zeroBankingCommand.parseAsync(["node", "cli", "accounts"]),
    ).rejects.toThrow("process.exit called");

    const errors = mockConsoleError.mock.calls.flat().join("\n");
    expect(errors).toContain("Not authenticated");
    expect(errors).toContain("Run: vm0 auth login");
  });
});
