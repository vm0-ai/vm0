import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";

const IMAGE_URL = "http://localhost:3000/api/image-io/generate";
const IMAGE_GENERATION_ID = "00000000-0000-4000-8000-000000000001";
const IMAGE_STATUS_URL = `http://localhost:3000/api/built-in-generations/${IMAGE_GENERATION_ID}`;

interface CapturedImageRequest {
  readonly prompt: string;
  readonly model: string;
  readonly size: string;
  readonly quality: string;
  readonly background: string;
  readonly outputFormat: string;
  readonly moderation: string;
  readonly safetyTolerance: string;
}

describe("okou generate image-batch command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  const temporaryDirectories: string[] = [];

  async function makeTemporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "okou-image-batch-test-"));
    temporaryDirectories.push(path);
    return path;
  }

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    await Promise.all(
      temporaryDirectories.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
      }),
    );
  });

  it("runs five jobs with at most three in flight, retries once, and preserves manifest order", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(
      manifestPath,
      [
        "hero\tHero dog portrait\t1536x1024",
        "detail\tDog collar detail\t1024x1024",
        "retry\tDog running through grass\t1024x1536",
        "team\tFour dogs together",
        "fifth\tDog asleep by a window\t2048x1024",
      ].join("\n"),
      "utf8",
    );
    await mkdir(stateDirectory);

    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const attempts = new Map<string, number>();
    const requests = new Map<string, CapturedImageRequest>();
    server.use(
      http.post(IMAGE_URL, async ({ request }) => {
        const body = (await request.json()) as CapturedImageRequest;
        requests.set(body.prompt, body);
        const attempt = (attempts.get(body.prompt) ?? 0) + 1;
        attempts.set(body.prompt, attempt);
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        await new Promise((resolvePromise) => {
          setTimeout(resolvePromise, 30);
        });
        activeRequests -= 1;

        if (body.prompt === "Dog running through grass" && attempt === 1) {
          return HttpResponse.json(
            { error: { message: "rate limited", code: "RATE_LIMITED" } },
            { status: 429 },
          );
        }
        const slug = body.prompt.toLowerCase().replaceAll(" ", "-");
        return HttpResponse.json({
          id: `image-${slug}`,
          filename: `${slug}.png`,
          contentType: "image/png",
          size: 19,
          url: `https://cdn.example/${slug}.png`,
          embedUrl: `https://embed.example/${slug}.png`,
          creditsCharged: 1,
          model: "seedream4",
          provider: "fal",
          imageSize: "1536x1024",
          quality: "low",
          background: "opaque",
          outputFormat: "png",
          moderation: "auto",
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "__run",
      manifestPath,
      stateDirectory,
    ]);

    expect(maximumActiveRequests).toBe(3);
    expect(attempts.get("Dog running through grass")).toBe(2);
    expect(requests.get("Dog collar detail")).toEqual({
      prompt: "Dog collar detail",
      model: "seedream4",
      size: "1024x1024",
      quality: "low",
      background: "auto",
      outputFormat: "png",
      moderation: "auto",
      safetyTolerance: "4",
    });
    expect(requests.get("Four dogs together")).toEqual({
      prompt: "Four dogs together",
      model: "seedream4",
      size: "816x816",
      quality: "low",
      background: "auto",
      outputFormat: "png",
      moderation: "auto",
      safetyTolerance: "4",
    });
    expect(requests.get("Dog asleep by a window")).toEqual({
      prompt: "Dog asleep by a window",
      model: "seedream4",
      size: "2048x1024",
      quality: "low",
      background: "auto",
      outputFormat: "png",
      moderation: "auto",
      safetyTolerance: "4",
    });
    expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("0\n");
    expect(await readFile(join(stateDirectory, "results.tsv"), "utf8")).toBe(
      [
        "hero\thttps://embed.example/hero-dog-portrait.png",
        "detail\thttps://embed.example/dog-collar-detail.png",
        "retry\thttps://embed.example/dog-running-through-grass.png",
        "team\thttps://embed.example/four-dogs-together.png",
        "fifth\thttps://embed.example/dog-asleep-by-a-window.png",
        "",
      ].join("\n"),
    );
  });

  it("does not automatically retry an async output safety block", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(manifestPath, "hero\tA safe landscape\n", "utf8");
    await mkdir(stateDirectory);

    let submissionCount = 0;
    server.use(
      http.post(IMAGE_URL, () => {
        submissionCount += 1;
        return HttpResponse.json(
          {
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "queued",
            realtime: {
              channelName: "user:user-1",
              eventName: `built-in-generation:${IMAGE_GENERATION_ID}`,
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
      http.get(IMAGE_STATUS_URL, () => {
        return HttpResponse.json({
          generationId: IMAGE_GENERATION_ID,
          type: "image",
          status: "failed",
          error: {
            message: "The generated image was blocked by the safety filter.",
            code: "GENERATION_OUTPUT_SAFETY_BLOCKED",
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: "2026-05-15T00:00:01.000Z",
          completedAt: "2026-05-15T00:00:02.000Z",
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "__run",
      manifestPath,
      stateDirectory,
    ]);

    expect(submissionCount).toBe(1);
    expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("1\n");
    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const stderr = mockConsoleError.mock.calls.flat().join("\n");
    expect(stdout).not.toContain("Retrying image batch job hero once");
    expect(stderr).toContain(
      "The generated image was blocked by the safety filter.",
    );
  });

  it.each([
    [
      "input safety rejection",
      "GENERATION_INPUT_SAFETY_REJECTED",
      "The prompt or reference image was blocked by the safety filter.",
    ],
    [
      "unreachable input image",
      "GENERATION_INPUT_MEDIA_UNREACHABLE",
      "An input image could not be downloaded by the generation provider.",
    ],
    [
      "invalid input image",
      "GENERATION_INPUT_MEDIA_INVALID",
      "An input image could not be read by the generation provider.",
    ],
    [
      "invalid generation parameters",
      "GENERATION_INVALID_PARAMETERS",
      "The image generation request contains invalid parameters.",
    ],
  ])(
    "does not automatically retry an async %s",
    async (_caseName, code, message) => {
      const root = await makeTemporaryDirectory();
      const manifestPath = join(root, "images.tsv");
      const stateDirectory = join(root, "state");
      await writeFile(manifestPath, "hero\tA safe landscape\n", "utf8");
      await mkdir(stateDirectory);

      let submissionCount = 0;
      server.use(
        http.post(IMAGE_URL, () => {
          submissionCount += 1;
          return HttpResponse.json(
            {
              generationId: IMAGE_GENERATION_ID,
              type: "image",
              status: "queued",
              realtime: {
                channelName: "user:user-1",
                eventName: `built-in-generation:${IMAGE_GENERATION_ID}`,
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
        http.get(IMAGE_STATUS_URL, () => {
          return HttpResponse.json({
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "failed",
            error: { message, code },
            createdAt: "2026-05-15T00:00:00.000Z",
            startedAt: "2026-05-15T00:00:01.000Z",
            completedAt: "2026-05-15T00:00:02.000Z",
          });
        }),
      );

      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "__run",
        manifestPath,
        stateDirectory,
      ]);

      expect(submissionCount).toBe(1);
      expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("1\n");
      expect(mockConsoleLog.mock.calls.flat().join("\n")).not.toContain(
        "Retrying image batch job hero once",
      );
      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(message);
    },
  );

  it("retries an async provider-unavailable failure once", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(manifestPath, "hero\tA safe landscape\n", "utf8");
    await mkdir(stateDirectory);

    let submissionCount = 0;
    server.use(
      http.post(IMAGE_URL, () => {
        submissionCount += 1;
        if (submissionCount === 2) {
          return HttpResponse.json({
            id: "image-provider-retry",
            filename: "provider-retry.png",
            contentType: "image/png",
            size: 19,
            url: "https://cdn.example/provider-retry.png",
            embedUrl: "https://embed.example/provider-retry.png",
            creditsCharged: 1,
            model: "seedream4",
            provider: "fal",
            imageSize: "816x816",
            quality: "low",
            background: "opaque",
            outputFormat: "png",
            moderation: "auto",
          });
        }
        return HttpResponse.json(
          {
            generationId: IMAGE_GENERATION_ID,
            type: "image",
            status: "queued",
            realtime: {
              channelName: "user:user-1",
              eventName: `built-in-generation:${IMAGE_GENERATION_ID}`,
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
      http.get(IMAGE_STATUS_URL, () => {
        return HttpResponse.json({
          generationId: IMAGE_GENERATION_ID,
          type: "image",
          status: "failed",
          error: {
            message:
              "The image generation provider is temporarily unavailable.",
            code: "GENERATION_PROVIDER_UNAVAILABLE",
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          startedAt: "2026-05-15T00:00:01.000Z",
          completedAt: "2026-05-15T00:00:02.000Z",
        });
      }),
    );

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "__run",
      manifestPath,
      stateDirectory,
    ]);

    expect(submissionCount).toBe(2);
    expect(await readFile(join(stateDirectory, "done"), "utf8")).toBe("0\n");
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "Retrying image batch job hero once",
    );
    expect(await readFile(join(stateDirectory, "results.tsv"), "utf8")).toBe(
      "hero\thttps://embed.example/provider-retry.png\n",
    );
  });

  it("starts a detached worker and waits for its result", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    const fixturePath = join(root, "batch-worker.mjs");
    await writeFile(manifestPath, "hero\tA happy dog\n", "utf8");
    await writeFile(
      fixturePath,
      `import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [manifestPath, stateDirectory] = process.argv.slice(-2);
const manifest = await readFile(manifestPath, "utf8");
const id = manifest.split("\\t", 1)[0];
await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
await writeFile(join(stateDirectory, "results.tsv"), id + "\\thttps://cdn.example/dog.png\\n", "utf8");
await writeFile(join(stateDirectory, "done"), "0\\n", "utf8");
`,
      "utf8",
    );

    const originalEntrypoint = process.argv[1];
    process.argv[1] = fixturePath;
    try {
      await generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "start",
        manifestPath,
        stateDirectory,
      ]);
    } finally {
      if (originalEntrypoint === undefined) {
        delete process.argv[1];
      } else {
        process.argv[1] = originalEntrypoint;
      }
    }

    await generateCommand.parseAsync([
      "node",
      "cli",
      "image-batch",
      "wait",
      stateDirectory,
      "--timeout",
      "5",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    expect(stdout).toContain(`Image batch started: ${stateDirectory}`);
    expect(stdout).toContain("hero\thttps://cdn.example/dog.png");
    expect(stdout).toContain(
      `Image batch joined: ${join(stateDirectory, "results.tsv")}`,
    );
  });
});
