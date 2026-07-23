import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../../mocks/server";
import { zeroFinanceCommand } from "../index";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "zero-finance-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

function financeResponse(operation: string, result: unknown) {
  return {
    operation,
    provider: "apidojo",
    billingCategory: "request",
    billingQuantity: 1,
    creditsCharged: 1,
    result,
  };
}

describe("zero finance command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const mockStderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => {
      return true;
    }) as never);
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);

  beforeEach(async () => {
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    for (const command of zeroFinanceCommand.commands) {
      command.setOptionValue("json", undefined);
      if (command.name() === "chart") {
        command.setOptionValue("range", "1y");
        command.setOptionValue("interval", "1d");
      }
    }
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    mockStderrWrite.mockClear();
    mockExit.mockClear();
    vi.unstubAllEnvs();
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
  });

  afterAll(async () => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockStderrWrite.mockRestore();
    mockExit.mockRestore();
    await fs.rm(TEST_HOME, { recursive: true, force: true });
  });

  it.each([
    {
      operation: "search",
      argument: "Tencent",
      request: { query: "Tencent" },
      result: { quotes: [{ symbol: "0700.HK" }] },
    },
    {
      operation: "profile",
      argument: "AAPL",
      request: { symbol: "AAPL" },
      result: { assetProfile: { industry: "Consumer Electronics" } },
    },
    {
      operation: "quote",
      argument: "0700.HK",
      request: { symbol: "0700.HK" },
      result: { quoteResponse: { result: [{ symbol: "0700.HK" }] } },
    },
  ])("posts $operation requests and prints JSON", async (example) => {
    let requestBody: unknown;
    const response = financeResponse(example.operation, example.result);
    server.use(
      http.post(
        `http://localhost:3000/api/zero/finance/${example.operation}`,
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(response);
        },
      ),
    );

    await zeroFinanceCommand.parseAsync([
      "node",
      "cli",
      example.operation,
      example.argument,
      "--json",
    ]);

    expect(requestBody).toStrictEqual(example.request);
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(response));
  });

  it("posts chart range and interval and renders raw provider data", async () => {
    let requestBody: unknown;
    const result = {
      chart: { result: [{ meta: { symbol: "AAPL" }, timestamp: [1, 2] }] },
    };
    server.use(
      http.post(
        "http://localhost:3000/api/zero/finance/chart",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(financeResponse("chart", result));
        },
      ),
    );

    await zeroFinanceCommand.parseAsync([
      "node",
      "cli",
      "chart",
      "AAPL",
      "--range",
      "5y",
      "--interval",
      "1wk",
    ]);

    expect(requestBody).toStrictEqual({
      symbol: "AAPL",
      range: "5y",
      interval: "1wk",
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("Finance chart completed");
    expect(output).toContain('"symbol": "AAPL"');
    expect(output).toContain("Provider: apidojo");
    expect(output).toContain("Credits charged: 1");
  });

  it("rejects invalid chart intervals before calling the API", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/zero/finance/chart", () => {
        apiRequests += 1;
        return HttpResponse.json(financeResponse("chart", {}));
      }),
    );

    await expect(
      zeroFinanceCommand.parseAsync([
        "node",
        "cli",
        "chart",
        "AAPL",
        "--interval",
        "4h",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = [
      ...mockConsoleError.mock.calls.flat(),
      ...mockStderrWrite.mock.calls.flat(),
    ]
      .map(String)
      .join("\n");
    expect(errors).toContain("interval must be one of");
    expect(apiRequests).toBe(0);
  });
});
