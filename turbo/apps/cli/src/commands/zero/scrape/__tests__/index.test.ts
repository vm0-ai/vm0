import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "os";

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroScrapeCommand } from "../index";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "zero-scrape-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

describe("zero scrape command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
    await fs.rm(path.join(TEST_HOME, ".vm0"), { recursive: true, force: true });
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  it("posts default markdown scrape requests and prints JSON", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/scrape",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            requestedUrl: "https://example.com",
            format: "markdown",
            mode: "standard",
            provider: "firecrawl",
            creditsCharged: 4,
            billingCategory: "standard.markdown",
            billingQuantity: 1,
            result: { markdown: "# Example" },
          });
        },
      ),
    );

    await zeroScrapeCommand.parseAsync([
      "node",
      "cli",
      "https://example.com",
      "--json",
    ]);

    expect(requestBody).toEqual({
      url: "https://example.com",
      format: "markdown",
      mode: "standard",
    });
    expect(mockConsoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        requestedUrl: "https://example.com",
        format: "markdown",
        mode: "standard",
        provider: "firecrawl",
        creditsCharged: 4,
        billingCategory: "standard.markdown",
        billingQuantity: 1,
        result: { markdown: "# Example" },
      }),
    );
  });

  it("posts enhanced link scrape requests and prints links", async () => {
    let requestBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/zero/scrape",
        async ({ request }) => {
          requestBody = await request.json();
          return HttpResponse.json({
            requestedUrl: "https://example.com",
            format: "links",
            mode: "enhanced",
            provider: "firecrawl",
            creditsCharged: 20,
            billingCategory: "enhanced.links",
            billingQuantity: 1,
            result: {
              links: ["https://example.com/a", "https://example.com/b"],
            },
          });
        },
      ),
    );

    await zeroScrapeCommand.parseAsync([
      "node",
      "cli",
      "https://example.com",
      "--format",
      "links",
      "--mode",
      "enhanced",
    ]);

    expect(requestBody).toEqual({
      url: "https://example.com",
      format: "links",
      mode: "enhanced",
    });
    expect(output()).toContain("Scrape completed");
    expect(output()).toContain("Provider: firecrawl");
    expect(output()).toContain("Billing category: enhanced.links");
    expect(output()).toContain("Credits charged: 20");
    expect(output()).toContain("https://example.com/a");
    expect(output()).toContain("https://example.com/b");
  });

  it("prints markdown in human-readable mode", async () => {
    server.use(
      http.post("http://localhost:3000/api/zero/scrape", () => {
        return HttpResponse.json({
          requestedUrl: "https://example.com",
          format: "markdown",
          mode: "standard",
          provider: "firecrawl",
          creditsCharged: 4,
          billingCategory: "standard.markdown",
          billingQuantity: 1,
          result: { markdown: "# Example\n\nContent" },
        });
      }),
    );

    await zeroScrapeCommand.parseAsync(["node", "cli", "https://example.com"]);

    expect(output()).toContain("Scrape completed");
    expect(output()).toContain("Billing category: standard.markdown");
    expect(output()).toContain("Credits charged: 4");
    expect(output()).toContain("# Example\n\nContent");
  });
});
