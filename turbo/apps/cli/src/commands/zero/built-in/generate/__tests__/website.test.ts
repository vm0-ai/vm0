/**
 * Tests for zero built-in generate website command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): none for the OpenDesign path
 * - Real (internal): prompt parsing and feature-gated authoring packet generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";
import chalk from "chalk";
import { server } from "../../../../../mocks/server";
import { zeroBuiltInCommand } from "../../index";

const WEBSITE_URL = "http://localhost:3000/api/zero/website-io/generate";
const WEBSITE_GENERATION_ID = "11111111-1111-4111-8111-111111111111";
const WEBSITE_STATUS_URL = `http://localhost:3000/api/zero/built-in-generations/${WEBSITE_GENERATION_ID}`;
const HOST_PREPARE_URL =
  "http://localhost:3000/api/zero/host/deployments/prepare";
const HOST_COMPLETE_URL =
  "http://localhost:3000/api/zero/host/deployments/22222222-2222-4222-8222-222222222222/complete";

const WEBSITE_RESULT = {
  generationId: WEBSITE_GENERATION_ID,
  templateId: "launch",
  templateLabel: "Launch site",
  slugSuggestion: "clearpath-observability",
  creditsCharged: 18,
  textCreditsCharged: 12,
  imageCreditsCharged: 6,
  model: "gpt-5.5",
  imageCount: 1,
  imageModel: "gpt-image-1",
  imageUrls: ["http://localhost:3000/f/user-1/image-file-id/image-visual.webp"],
  generatedVisuals: [
    {
      placement: "hero",
      url: "http://localhost:3000/f/user-1/image-file-id/image-visual.webp",
      alt: "Abstract observability workspace visual",
      prompt: "Create a 16:9 website image for Clearpath Observability.",
      imageId: "image-file-id",
      filename: "image-visual.webp",
      creditsCharged: 6,
    },
  ],
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
    visuals: [
      {
        placement: "hero",
        prompt: "A calm observability workspace visual",
        alt: "Abstract observability workspace visual",
      },
    ],
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

function buildZeroToken(openDesignGenerate: boolean): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "zero",
      capabilities: ["file:write", "host:write"],
      featureSwitches: {
        [FeatureSwitchKey.OpenDesignGenerate]: openDesignGenerate,
      },
      iat: 1_700_000_000,
      exp: 1_700_007_200,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
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
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(true));
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("should generate, build, and host a billed website when openDesignGenerate is disabled", async () => {
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(false));
    const uploadedPaths: string[] = [];
    let prepareBody: PrepareBody | null = null;
    let statusRequested = false;
    server.use(
      http.post(WEBSITE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toMatch(
          /^Bearer vm0_sandbox_/u,
        );
        expect(await request.json()).toEqual({
          prompt: "observability launch site",
          template: "launch",
          imageCount: 1,
          title: "Clearpath",
          audience: "small engineering teams",
        });
        return HttpResponse.json(
          {
            generationId: WEBSITE_GENERATION_ID,
            type: "website",
            status: "queued",
            realtime: {
              channelName: "user:user-1",
              eventName: `built-in-generation:${WEBSITE_GENERATION_ID}`,
              tokenRequest: {
                keyName: "test-key",
                timestamp: 1_700_000_000_000,
                capability: '{"user:user-1":["subscribe"]}',
                clientId: "user-1",
                nonce: "test-nonce",
                mac: "test-mac",
              },
            },
          },
          { status: 202 },
        );
      }),
      http.get(WEBSITE_STATUS_URL, ({ request }) => {
        statusRequested = true;
        expect(request.headers.get("authorization")).toMatch(
          /^Bearer vm0_sandbox_/u,
        );
        return HttpResponse.json({
          generationId: WEBSITE_GENERATION_ID,
          type: "website",
          status: "completed",
          result: WEBSITE_RESULT,
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: "2026-05-15T00:00:01.000Z",
          completedAt: "2026-05-15T00:00:02.000Z",
        });
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
    expect(statusRequested).toBe(true);

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
      textCreditsCharged: 12,
      imageCreditsCharged: 6,
      model: "gpt-5.5",
      imageCount: 1,
      imageModel: "gpt-image-1",
      imageUrls: WEBSITE_RESULT.imageUrls,
      responseId: "resp_website",
      generationId: "11111111-1111-4111-8111-111111111111",
      usage: WEBSITE_RESULT.usage,
    });
    expect(parsed.size).toEqual(expect.any(Number));
  });

  it("should surface billed website API errors when openDesignGenerate is disabled", async () => {
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(false));
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

  it("should print OpenDesign-style website authoring instructions", async () => {
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
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain("# Zero built-in generate website");
    expect(stdout).toContain("You are the current agent");
    expect(stdout).toContain("observability launch site");
    expect(stdout).toContain(
      "Write the artifact under `./opendesign/mockups/clearpath-demo/`.",
    );
    expect(stdout).toContain(
      "zero host ./opendesign/mockups/clearpath-demo --site clearpath-demo --spa",
    );
    expect(stdout).toContain("Template direction: launch");
    expect(stdout).toContain("Audience: small engineering teams");
  });

  it("should print JSON authoring metadata when --json is provided", async () => {
    await zeroBuiltInCommand.parseAsync([
      "node",
      "cli",
      "generate",
      "website",
      "--prompt",
      "observability launch site",
      "--site",
      "clearpath-demo",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      type: "html-artifact-authoring",
      kind: "website",
      prompt: "observability launch site",
      outputDir: "./opendesign/mockups/clearpath-demo",
      site: "clearpath-demo",
      hostCommand:
        "zero host ./opendesign/mockups/clearpath-demo --site clearpath-demo --spa",
    });
    expect(parsed.instructions).toEqual(expect.stringContaining("Publish"));
  });

  it("should require a prompt", async () => {
    await expect(async () => {
      await zeroBuiltInCommand.parseAsync([
        "node",
        "cli",
        "generate",
        "website",
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("--prompt is required"),
    );
  });
});
