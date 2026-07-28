import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { findRegistryResourceForPull, zeroResourceCommand } from "../index";
import { VM0_ILLUSTRATION_ARCHIVE } from "./fixtures/vm0-illustration-archive";

describe("zero resource pull registry resolver", () => {
  it("resolves a presentation color system archive", () => {
    expect(findRegistryResourceForPull("color-system:carnival")).toEqual(
      expect.objectContaining({
        id: "color-system:carnival",
        kind: "color-system",
        source: expect.objectContaining({
          path: "presentation-color-system/carnival",
          archive: expect.objectContaining({ type: "tar.gz" }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed presentation color system ids", () => {
    expect(findRegistryResourceForPull("carnival")?.id).toBe(
      "color-system:carnival",
    );
  });

  it("resolves a built-in website template package archive", () => {
    expect(findRegistryResourceForPull("template:dot-matrix")).toEqual(
      expect.objectContaining({
        id: "template:dot-matrix",
        kind: "template",
        targets: ["website"],
        source: expect.objectContaining({
          path: "dot-matrix",
          archive: expect.objectContaining({
            type: "tar.gz",
            sha256:
              "f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2",
          }),
        }),
      }),
    );
  });

  it("canonicalizes unprefixed built-in website template ids", () => {
    expect(findRegistryResourceForPull("dot-matrix")?.id).toBe(
      "template:dot-matrix",
    );
  });

  it("rejects retired website template v2 packages", () => {
    expect(
      findRegistryResourceForPull("template:black-slabs-v2"),
    ).toBeUndefined();
  });
});

describe("zero resource pull command", () => {
  const downloadUrl = "https://r2.example.com/registry/vm0-illustration.tar.gz";
  const sha256 =
    "03e77d6968190b9f1888a900963135e92f75b40a6c37e1c1bae999ea49669a37";
  const versionId =
    "820d2e2ce81805d935e4098d5b6f2899967c2ad5c0af4586f794010c6db66966";
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let outputDir: string;

  function registryDownload(archive: Buffer) {
    return [
      http.get(
        "http://localhost:3000/api/registry/resources/download",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("id")).toBe(
            "image-style:vm0-illustration",
          );
          expect(url.searchParams.get("expectedSha256")).toBe(sha256);
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          return HttpResponse.json({
            url: downloadUrl,
            id: "image-style:vm0-illustration",
            type: "tar.gz",
            sha256,
            expiresInSeconds: 900,
            versionId,
            fileCount: 1,
            size: 6054,
          });
        },
      ),
      http.get(downloadUrl, () => {
        return new HttpResponse(archive, {
          headers: { "content-type": "application/gzip" },
        });
      }),
    ] as const;
  }

  beforeEach(async () => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
    outputDir = await mkdtemp(path.join(tmpdir(), "zero-resource-pull-test-"));
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(outputDir, { recursive: true, force: true });
  });

  it("downloads, verifies, and extracts an image style archive", async () => {
    server.use(...registryDownload(VM0_ILLUSTRATION_ARCHIVE));

    await zeroResourceCommand.parseAsync([
      "node",
      "cli",
      "pull",
      "image-style:vm0-illustration",
      "--dir",
      outputDir,
    ]);

    const skill = await readFile(
      path.join(outputDir, "illustration-template/vm0-illustration/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("# vm0 Illustration");
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      "✓ Pulled image-style:vm0-illustration",
    );
  });

  it("rejects an archive whose bytes do not match the registry digest", async () => {
    server.use(
      ...registryDownload(Buffer.from("not the published archive", "utf8")),
    );

    await expect(
      zeroResourceCommand.parseAsync([
        "node",
        "cli",
        "pull",
        "image-style:vm0-illustration",
        "--dir",
        outputDir,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Resource archive digest mismatch",
    );
  });
});
