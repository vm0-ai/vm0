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

import { server } from "../../../mocks/server";
import { seoCommand } from "../index";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "seo-home-"));
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

describe("okou seo command", () => {
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
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    for (const command of seoCommand.commands) {
      command.setOptionValue("json", undefined);
      if (command.name() === "serp") {
        command.setOptionValue("engine", "google");
        command.setOptionValue("location", "United States");
        command.setOptionValue("language", "en");
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

  it("posts DataForSEO SERP options and prints the JSON response", async () => {
    let requestBody: unknown;
    const response = dataForSeoResponse("serp", {
      tasks: [{ result: [{ title: "Coffee" }] }],
    });
    server.use(
      http.post("http://localhost:3000/api/seo/serp", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json(response);
      }),
    );

    await seoCommand.parseAsync([
      "node",
      "cli",
      "serp",
      "coffee shops",
      "--engine",
      "google_maps",
      "--location",
      "Austin, Texas, United States",
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
      provider: "dataforseo",
      engine: "google_maps",
      location: "Austin, Texas, United States",
      languageCode: "en",
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
        "http://localhost:3000/api/seo/keyword-ideas",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json(response);
        },
      ),
    );

    await seoCommand.parseAsync([
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

  it("posts supported DataForSEO search engines", async () => {
    let requestBody: unknown;
    server.use(
      http.post("http://localhost:3000/api/seo/serp", async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json(dataForSeoResponse("serp", {}));
      }),
    );

    await seoCommand.parseAsync([
      "node",
      "cli",
      "serp",
      "technical seo",
      "--engine",
      "bing",
      "--device",
      "mobile",
      "--limit",
      "20",
    ]);

    expect(requestBody).toStrictEqual({
      query: "technical seo",
      provider: "dataforseo",
      engine: "bing",
      location: "United States",
      languageCode: "en",
      device: "mobile",
      limit: 20,
    });
  });

  it("rejects mobile DataForSEO Google News before calling the API", async () => {
    let apiRequests = 0;
    server.use(
      http.post("http://localhost:3000/api/seo/serp", () => {
        apiRequests += 1;
        return HttpResponse.json(dataForSeoResponse("serp", {}));
      }),
    );

    await expect(
      seoCommand.parseAsync([
        "node",
        "cli",
        "serp",
        "ai news",
        "--engine",
        "google_news",
        "--device",
        "mobile",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = [
      ...mockConsoleError.mock.calls.flat(),
      ...mockStderrWrite.mock.calls.flat(),
    ]
      .map(String)
      .join("\n");
    expect(errors).toContain(
      "DataForSEO Google News supports only the desktop device",
    );
    expect(apiRequests).toBe(0);
  });

  it("explains DataForSEO engine compatibility in serp help", () => {
    const command = seoCommand.commands.find((candidate) => {
      return candidate.name() === "serp";
    });
    if (!command) {
      throw new Error("Okou SEO serp command is missing");
    }
    let help = "";
    command.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });

    command.outputHelp();

    expect(help).toContain("Provider:");
    expect(help).toContain("DataForSEO is the only managed SEO provider");
    expect(help).toContain("provider-reported cost +25%");
    expect(help).toContain("google_news  desktop only");
    expect(help).toContain("google_maps returns at most 20 results on mobile");
  });
});
