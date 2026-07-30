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
const ALIAS_URL = "https://demo-site.sites.example.com";
const ARTIFACT_URL =
  "https://dpl-00000000-0000-4000-8000-000000000002.sites.example.com";
const CHAT_SCOPE_CONFLICT_MESSAGE =
  'Hosted site slug "demo-site" is owned outside this chat. Choose a different --site value and rerun the same zero host command.';

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
  const stderrIsTtyDescriptor = Object.getOwnPropertyDescriptor(
    process.stderr,
    "isTTY",
  );

  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
    tempDir = join(tmpdir(), `zero-host-publish-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    if (stderrIsTtyDescriptor) {
      Object.defineProperty(process.stderr, "isTTY", stderrIsTtyDescriptor);
    } else {
      Reflect.deleteProperty(process.stderr, "isTTY");
    }
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
        expect(body.slugSuffix).toBeUndefined();

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
          publicSlug: "demo-site",
          url: ALIAS_URL,
          deploymentVersion: 1,
          artifactUrl: ARTIFACT_URL,
          aliasUrl: ALIAS_URL,
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
          publicSlug: "demo-site",
          url: ALIAS_URL,
          deploymentVersion: 1,
          artifactUrl: ARTIFACT_URL,
          aliasUrl: ALIAS_URL,
          isActive: true,
          activeDeploymentVersion: 1,
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
      publicSlug: "demo-site",
      deploymentVersion: 1,
      artifactUrl: ARTIFACT_URL,
      aliasUrl: ALIAS_URL,
      isActive: true,
      fileCount: 2,
      size:
        Buffer.byteLength(index) +
        Buffer.byteLength(DEFAULT_HOSTED_SITE_ROBOTS_TXT),
    });
  });

  it("preserves the legacy suffix and response shape during rollout", async () => {
    const index = "<!doctype html><main>Legacy hosted site</main>";
    const legacyPublicSlug = "demo-site-a1b2c3d4-release-01";
    const legacyUrl = `https://${legacyPublicSlug}.sites.example.com`;

    writeFileSync(join(tempDir, "index.html"), index);
    expect(zeroHostCommand.helpInformation()).toContain(
      "--slug-suffix <suffix>",
    );

    server.use(
      http.post(PREPARE_URL, async ({ request }) => {
        const body = hostedSitePrepareRequestSchema.parse(await request.json());
        expect(body.slugSuffix).toBe("release-01");
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000004",
          publicSlug: legacyPublicSlug,
          url: legacyUrl,
          uploads: [
            { path: "/index.html", uploadUrl: INDEX_UPLOAD_URL },
            { path: "/robots.txt", uploadUrl: ROBOTS_UPLOAD_URL },
          ],
        });
      }),
      http.put(INDEX_UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.put(ROBOTS_UPLOAD_URL, () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(COMPLETE_URL, () => {
        return HttpResponse.json({
          siteId: "00000000-0000-4000-8000-000000000001",
          deploymentId: "00000000-0000-4000-8000-000000000004",
          publicSlug: legacyPublicSlug,
          url: legacyUrl,
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
      "--slug-suffix",
      "release-01",
      "--spa",
      "--json",
    ]);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      publicSlug: legacyPublicSlug,
      url: legacyUrl,
    });
    expect(parsed.deploymentVersion).toBeUndefined();
    expect(parsed.artifactUrl).toBeUndefined();
    expect(parsed.aliasUrl).toBeUndefined();
  });

  it.each([
    { label: "TTY", isTty: true, extraArgs: [] },
    { label: "non-TTY JSON", isTty: false, extraArgs: ["--json"] },
  ])(
    "prints actionable chat-scope conflicts in $label mode",
    async ({ isTty, extraArgs }) => {
      writeFileSync(
        join(tempDir, "index.html"),
        "<!doctype html><main>Hosted site</main>",
      );
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        value: isTty,
      });
      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                code: "CONFLICT",
                message: CHAT_SCOPE_CONFLICT_MESSAGE,
              },
            },
            { status: 409 },
          );
        }),
      );

      await expect(
        zeroHostCommand.parseAsync([
          "node",
          "cli",
          tempDir,
          "--site",
          "demo-site",
          ...extraArgs,
        ]),
      ).rejects.toThrow("process.exit called");

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        `409: ${CHAT_SCOPE_CONFLICT_MESSAGE}`,
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    },
  );
});
