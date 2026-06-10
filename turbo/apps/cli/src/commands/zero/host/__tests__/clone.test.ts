import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroHostCommand } from "../index";

const FILES_URL = "http://localhost:3000/api/zero/host/sites/:publicSlug/files";
const HOSTED_SITE_URL =
  "https://demo-site-a1b2c3d4-release-01.sites.example.com";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("zero host clone command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    tempDir = join(tmpdir(), `zero-host-clone-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("downloads hosted site files to the destination directory", async () => {
    const index = Buffer.from("<!doctype html><h1>Hello</h1>");
    const script = Buffer.from("console.log('hello');");
    const destination = join(tempDir, "site");

    server.use(
      http.get(FILES_URL, ({ params, request }) => {
        expect(params.publicSlug).toBe("demo-site-a1b2c3d4-release-01");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000002",
          publicSlug: "demo-site-a1b2c3d4-release-01",
          url: HOSTED_SITE_URL,
          fileCount: 2,
          size: index.byteLength + script.byteLength,
          files: [
            {
              path: "/index.html",
              size: index.byteLength,
              sha256: sha256(index),
              contentType: "text/html; charset=utf-8",
            },
            {
              path: "/assets/app.js",
              size: script.byteLength,
              sha256: sha256(script),
              contentType: "application/javascript; charset=utf-8",
              immutable: true,
            },
          ],
        });
      }),
      http.get(`${HOSTED_SITE_URL}/index.html`, () => {
        return new HttpResponse(index);
      }),
      http.get(`${HOSTED_SITE_URL}/assets/app.js`, () => {
        return new HttpResponse(script);
      }),
    );

    await zeroHostCommand.parseAsync([
      "node",
      "cli",
      "clone",
      HOSTED_SITE_URL,
      destination,
      "--json",
    ]);

    expect(readFileSync(join(destination, "index.html")).equals(index)).toBe(
      true,
    );
    expect(
      readFileSync(join(destination, "assets", "app.js")).equals(script),
    ).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      publicSlug: "demo-site-a1b2c3d4-release-01",
      destination,
      fileCount: 2,
    });
  });

  it("uses the public slug as the default destination", async () => {
    const index = Buffer.from("<!doctype html>");

    server.use(
      http.get(FILES_URL, () => {
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000002",
          publicSlug: "demo-site-a1b2c3d4-release-01",
          url: HOSTED_SITE_URL,
          fileCount: 1,
          size: index.byteLength,
          files: [
            {
              path: "/index.html",
              size: index.byteLength,
              sha256: sha256(index),
              contentType: "text/html; charset=utf-8",
            },
          ],
        });
      }),
      http.get(`${HOSTED_SITE_URL}/index.html`, () => {
        return new HttpResponse(index);
      }),
    );

    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      await zeroHostCommand.parseAsync([
        "node",
        "cli",
        "clone",
        "demo-site-a1b2c3d4-release-01",
        "--json",
      ]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(
      existsSync(join(tempDir, "demo-site-a1b2c3d4-release-01", "index.html")),
    ).toBe(true);
  });

  it("fails when the destination directory is not empty", async () => {
    const destination = join(tempDir, "existing");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "file.txt"), "content");

    await expect(async () => {
      await zeroHostCommand.parseAsync([
        "node",
        "cli",
        "clone",
        "demo-site-a1b2c3d4-release-01",
        destination,
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("is not empty"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("surfaces hosted site access errors", async () => {
    server.use(
      http.get(FILES_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Hosted site not found",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await zeroHostCommand.parseAsync([
        "node",
        "cli",
        "clone",
        "missing-site-a1b2c3d4-release-01",
        join(tempDir, "missing"),
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Hosted site not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
