import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostedSitePrepareRequestSchema } from "@vm0/api-contracts/contracts/zero-host";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_HOSTED_SITE_ROBOTS_TXT } from "../../../../lib/host/static-site";
import { server } from "../../../../mocks/server";
import { zeroHostCommand } from "../index";

const PREPARE_URL = "http://localhost:3000/api/zero/host/deployments/prepare";
const COMPLETE_URL =
  "http://localhost:3000/api/zero/host/deployments/:deploymentId/complete";
const INDEX_UPLOAD_URL = "https://uploads.example.com/index";
const ROBOTS_UPLOAD_URL = "https://uploads.example.com/robots";

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("zero host publish command", () => {
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
    vi.stubEnv("ZERO_TOKEN", "test-token");
    vi.stubEnv("VM0_TOKEN", "test-token");
    tempDir = join(tmpdir(), `zero-host-publish-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("uploads a default robots.txt when the site does not include one", async () => {
    const index = "<!doctype html><main>Hosted site</main>";
    let uploadedRobots = false;

    writeFileSync(join(tempDir, "index.html"), index);

    server.use(
      http.post(PREPARE_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        const body = hostedSitePrepareRequestSchema.parse(await request.json());
        expect(body).toMatchObject({
          site: "demo-site",
          artifactKind: "hosted-site",
          spaFallback: true,
        });

        const filesByPath = new Map(
          body.files.map((file) => {
            return [file.path, file];
          }),
        );

        expect(filesByPath.get("/index.html")).toMatchObject({
          size: Buffer.byteLength(index),
          sha256: sha256(index),
          contentType: "text/html; charset=utf-8",
        });
        expect(filesByPath.get("/robots.txt")).toMatchObject({
          size: Buffer.byteLength(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
          sha256: sha256(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
          contentType: "text/plain; charset=utf-8",
        });

        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000002",
          publicSlug: "demo-site-a1b2c3d4-release-01",
          url: "https://demo-site-a1b2c3d4-release-01.sites.example.com",
          uploads: [
            { path: "/index.html", uploadUrl: INDEX_UPLOAD_URL },
            { path: "/robots.txt", uploadUrl: ROBOTS_UPLOAD_URL },
          ],
        });
      }),
      http.put(INDEX_UPLOAD_URL, async ({ request }) => {
        expect(await request.text()).toBe(index);
        return new HttpResponse(null, { status: 200 });
      }),
      http.put(ROBOTS_UPLOAD_URL, async ({ request }) => {
        uploadedRobots = true;
        expect(await request.text()).toBe(DEFAULT_HOSTED_SITE_ROBOTS_TXT);
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(COMPLETE_URL, ({ params }) => {
        expect(params.deploymentId).toBe(
          "00000000-0000-4000-8000-000000000002",
        );
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000002",
          publicSlug: "demo-site-a1b2c3d4-release-01",
          url: "https://demo-site-a1b2c3d4-release-01.sites.example.com",
          status: "ready",
        });
      }),
    );

    await zeroHostCommand.parseAsync([
      "node",
      "cli",
      tempDir,
      "--site",
      "demo-site",
      "--spa",
      "--json",
    ]);

    expect(uploadedRobots).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      publicSlug: "demo-site-a1b2c3d4-release-01",
      fileCount: 2,
      size:
        Buffer.byteLength(index) +
        Buffer.byteLength(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
    });
  });
});
