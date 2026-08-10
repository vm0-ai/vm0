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
import { zeroSeoCommand } from "../index";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "zero-seo-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

function dataForSeoResponse(operation: string, result: unknown) {
  return {
    operation,
    provider: "dataforseo",
    billingCategory: "provider_cost_usd_micros",
    billingQuantity: 24_000,
    providerCostUsd: 0.024,
    creditsCharged: 30,
    result,
  };
}

function serpApiResponse(result: unknown) {
  return {
    operation: "serp",
    provider: "serpapi",
    billingCategory: "search",
    billingQuantity: 1,
    cached: false,
    creditsCharged: 32,
    result,
  };
}

describe("zero seo command", () => {
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
    for (const command of zeroSeoCommand.commands) {
      command.setOptionValue("json", undefined);
      if (command.name() === "serp") {
        command.setOptionValue("provider", "dataforseo");
        command.setOptionValue("engine", "google");
        command.setOptionValue("location", "United States");
        command.setOptionValue("language", "en");
        command.setOptionValue("country", "us");
        command.setOptionValue("device", "desktop");
        command.setOptionValue("limit", 10);
      } else if (command.name() === "backlinks-summary") {
        command.setOptionValue("excludeSubdomains", undefined);
      } else {
        command.setOptionValue("location", "United States");
        command.setOptionValue("language", "en");
        command.setOptionValue("limit", 100);
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

  it("posts SerpAPI options and prints the JSON response", async () => {
    let requestBody: unknown;
    const response = serpApiResponse({ local_results: [{ title: "Coffee" }] });
    server.use(
      http.post(
        "http://localhost:3000/api/zero/seo/serp",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(response);
        },
      ),
    );

    await zeroSeoCommand.parseAsync([
      "node",
      "cli",
      "serp",
      "coffee shops",
      "--provider",
      "serpapi",
      "--engine",
      "google_maps",
      "--location",
      "Austin, Texas, United States",
      "--country",
      "us",
      "--language",
      "en",
      "--device",
      "mobile",
      "--limit",
      "20",
      "--json",
    ]);

    expect(requestBody).toStrictEqual({
      query: "coffee shops",
      provider: "serpapi",
      engine: "google_maps",
      location: "Austin, Texas, United States",
      languageCode: "en",
      countryCode: "us",
      device: "mobile",
      limit: 20,
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(response));
  });

  it("posts DataForSEO keyword defaults and renders billing metadata", async () => {
    let requestBody: unknown;
    const response = dataForSeoResponse("keyword-ideas", {
      tasks: [{ result: [{ keyword: "seo audit" }] }],
    });
    server.use(
      http.post(
        "http://localhost:3000/api/zero/seo/keyword-ideas",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(response);
        },
      ),
    );

    await zeroSeoCommand.parseAsync([
      "node",
      "cli",
      "keyword-ideas",
      "technical seo",
    ]);

    expect(requestBody).toStrictEqual({
      keyword: "technical seo",
      location: "United States",
      languageCode: "en",
      limit: 100,
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("SEO keyword-ideas completed");
    expect(output).toContain("Provider: dataforseo");
    expect(output).toContain("Provider cost: $0.024000");
    expect(output).toContain("Credits charged: 30");
  });

  it("rejects non-Google DataForSEO engines before calling the API", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/zero/seo/serp", () => {
        apiRequests += 1;
        return HttpResponse.json(dataForSeoResponse("serp", {}));
      }),
    );

    await expect(
      zeroSeoCommand.parseAsync([
        "node",
        "cli",
        "serp",
        "technical seo",
        "--engine",
        "bing",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = [
      ...mockConsoleError.mock.calls.flat(),
      ...mockStderrWrite.mock.calls.flat(),
    ]
      .map(String)
      .join("\n");
    expect(errors).toContain("supports only the google engine");
    expect(apiRequests).toBe(0);
  });
});
