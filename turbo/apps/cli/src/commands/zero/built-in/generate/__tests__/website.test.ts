/**
 * Tests for zero built-in generate website command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend website and host routes via MSW
 * - Real (internal): React template build, static scan, and upload orchestration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpResponse, http } from "msw";
import chalk from "chalk";
import { server } from "../../../../../mocks/server";
import { zeroBuiltInCommand } from "../../index";

const WEBSITE_URL = "http://localhost:3000/api/zero/website-io/generate";
const HOST_PREPARE_URL =
  "http://localhost:3000/api/zero/host/deployments/prepare";
const HOST_COMPLETE_URL =
  "http://localhost:3000/api/zero/host/deployments/22222222-2222-4222-8222-222222222222/complete";

const WEBSITE_RESULT = {
  generationId: "11111111-1111-4111-8111-111111111111",
  templateId: "launch",
  templateLabel: "Launch site",
  slugSuggestion: "clearpath-observability",
  creditsCharged: 18,
  model: "gpt-5.5",
  responseId: "resp_website",
  usage: {
    inputTokens: 1200,
    outputTokens: 480,
    totalTokens: 1680,
  },
  siteData: {
    siteName: "Clearpath Observability",
    eyebrow: "Developer operations",
    headline: "Find production issues before customers do",
    subhead:
      "A focused observability workspace for small teams that need fast traces, useful alerts, and calmer on-call rotations.",
    primaryCta: { label: "Start monitoring", href: "#contact" },
    secondaryCta: { label: "See features", href: "#features" },
    highlights: [
      {
        title: "Trace-first debugging",
        body: "Move from alert to exact request path without hunting.",
      },
      {
        title: "Compact incident rooms",
        body: "Keep logs, owners, deploys, and decisions in one view.",
      },
      {
        title: "Human-scale alerts",
        body: "Tune noise down with service-aware thresholds.",
      },
    ],
    sections: [
      {
        kicker: "Workflow",
        title: "Built for the first hour of an incident",
        body: "Move from signal to action quickly.",
        bullets: ["Surface deploys", "Group traces", "Record decisions"],
      },
      {
        kicker: "Rollout",
        title: "Adopt it service by service",
        body: "Start with one critical path and expand from there.",
        bullets: ["Start with checkout", "Review noise", "Share runbooks"],
      },
    ],
    stats: [
      { value: "15 min", label: "target setup time" },
      { value: "3 views", label: "alert, trace, decision" },
    ],
    footer: {
      title: "Ready for a calmer on-call loop",
      body: "Publish the first service dashboard and use it in review.",
      cta: { label: "Book a walkthrough", href: "#top" },
    },
    theme: { accent: "cobalt", tone: "light" },
  },
};

interface PrepareBody {
  readonly site: string;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
    readonly contentType: string;
    readonly immutable?: boolean;
  }[];
}

describe("zero built-in generate website command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("should generate, build, host, and print JSON metadata", async () => {
    const uploadedPaths: string[] = [];
    let prepareBody: PrepareBody | null = null;
    server.use(
      http.post(WEBSITE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(await request.json()).toEqual({
          prompt: "observability launch site",
          template: "launch",
          title: "Clearpath",
          audience: "small engineering teams",
        });
        return HttpResponse.json(WEBSITE_RESULT);
      }),
      http.post(HOST_PREPARE_URL, async ({ request }) => {
        prepareBody = (await request.json()) as PrepareBody;
        return HttpResponse.json({
          siteId: "33333333-3333-4333-8333-333333333333",
          deploymentId: "22222222-2222-4222-8222-222222222222",
          publicSlug: "clearpath-demo-a1b2c3d4",
          url: "https://clearpath-demo-a1b2c3d4.sites.example.com",
          uploads: prepareBody.files.map((file) => {
            return {
              path: file.path,
              uploadUrl: `http://localhost:3000/upload${file.path}`,
            };
          }),
        });
      }),
      http.put("http://localhost:3000/upload/*", async ({ request }) => {
        uploadedPaths.push(
          new URL(request.url).pathname.replace("/upload", ""),
        );
        await request.arrayBuffer();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(HOST_COMPLETE_URL, () => {
        return HttpResponse.json({
          siteId: "33333333-3333-4333-8333-333333333333",
          deploymentId: "22222222-2222-4222-8222-222222222222",
          publicSlug: "clearpath-demo-a1b2c3d4",
          url: "https://clearpath-demo-a1b2c3d4.sites.example.com",
          status: "ready",
        });
      }),
    );

    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "website",
      "--prompt",
      "observability launch site",
      "--template",
      "launch",
      "--title",
      "Clearpath",
      "--audience",
      "small engineering teams",
      "--site",
      "clearpath-demo",
      "--json",
    ]);

    expect(prepareBody).toMatchObject({
      site: "clearpath-demo",
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "/assets/styles.css",
          contentType: "text/css; charset=utf-8",
          immutable: true,
        }),
        expect.objectContaining({
          path: "/index.html",
          contentType: "text/html; charset=utf-8",
        }),
      ]),
    });
    expect(uploadedPaths.sort()).toStrictEqual([
      "/assets/styles.css",
      "/index.html",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      url: "https://clearpath-demo-a1b2c3d4.sites.example.com",
      publicSlug: "clearpath-demo-a1b2c3d4",
      site: "clearpath-demo",
      templateId: "launch",
      templateLabel: "Launch site",
      fileCount: 2,
      creditsCharged: 18,
      model: "gpt-5.5",
      responseId: "resp_website",
      generationId: "11111111-1111-4111-8111-111111111111",
      usage: WEBSITE_RESULT.usage,
    });
    expect(parsed.size).toEqual(expect.any(Number));
  });

  it("should surface API errors", async () => {
    server.use(
      http.post(WEBSITE_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Not enough credits",
              code: "INSUFFICIENT_CREDITS",
            },
          },
          { status: 402 },
        );
      }),
    );

    await expect(async () => {
      await zeroBuiltInCommand.parseAsync([
        "node",
        "cli",
        "generate",
        "website",
        "--prompt",
        "hello",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Credits depleted"),
    );
  });
});
