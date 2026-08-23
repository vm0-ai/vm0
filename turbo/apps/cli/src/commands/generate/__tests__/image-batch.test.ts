import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import { generateCommand } from "../index";

const IMAGE_URL = "http://localhost:3000/api/image-io/generate";

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
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
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

  it("runs three jobs concurrently, retries once, and preserves manifest order", async () => {
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
      size: "1536x1024",
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
        "",
      ].join("\n"),
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

  it("rejects more than four jobs before creating the state directory", async () => {
    const root = await makeTemporaryDirectory();
    const manifestPath = join(root, "images.tsv");
    const stateDirectory = join(root, "state");
    await writeFile(
      manifestPath,
      Array.from({ length: 5 }, (_, index) => {
        return `asset-${index}\tDog image ${index}`;
      }).join("\n"),
      "utf8",
    );

    await expect(
      generateCommand.parseAsync([
        "node",
        "cli",
        "image-batch",
        "start",
        manifestPath,
        stateDirectory,
      ]),
    ).rejects.toThrow("process.exit called");
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Image batch manifest may contain at most 4 jobs",
    );
    await expect(readFile(stateDirectory, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
