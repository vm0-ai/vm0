import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WEBSITE_TEMPLATE_ITEMS } from "@vm0/core";
import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { findRegistryResourceForPull, zeroResourceCommand } from "../index";
import { VM0_ILLUSTRATION_ARCHIVE } from "./fixtures/vm0-illustration-archive";

const EXPECTED_WEBSITE_TEMPLATE_V2_SHA256: Record<string, string> = {
  "black-slabs":
    "840a02ad6e9caac5abfa6abea991f7a0c71fdee16700011d64ad3af7013164cc",
  "blueprint-grid":
    "8d02b52dfe72d8d0e59ba69e6ee9ffe3ae527c68e6cc89afe04264801c5c8d53",
  "coastal-hotel":
    "b9e2ac6e12ee525ce8896b704071eebf439590700d95060c6db76c90d167a08e",
  "dot-matrix":
    "823b02b5ac17d4899de867b99a9332912f6ace671cce8a72a91cff9426a661b3",
  "frame-stack":
    "c2a9d32dadbc0e00c3e29fe78eebe6525757b81e21d39eb25cbf34adb98e2322",
  "frosted-scatter":
    "a2a191134d56a33b90bfc0540c97a022f8f4b028d942ddcd482380ad5e9589ca",
  "gallery-wall":
    "0295121b12c8ded9a93efd3781e308020ffcb5b71b1f9fc682cac96cf4d5c14a",
  "glass-bloom":
    "48374e9ded67087f481b82d260a70438aa2fd9abc33367e4190fa5fb606214e4",
  "serif-stack":
    "9cb399465cb5c66ae7fb857986450ef154e7dc7c6e7c59a89281011933c55ab3",
  "sticker-pop":
    "5802135c5f922d6ae3748d13468e6bc24549f70c946fdf109b34ff02de471b09",
  "warm-cards":
    "0973164b9b4e3811ab565430043f74a6fa0546ca6f215db64a1eb79bd14542e6",
};

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

  it("resolves every feature-switched website v2 package", () => {
    for (const item of WEBSITE_TEMPLATE_ITEMS) {
      const resourceId = `${item.resourceId}-v2`;

      expect(findRegistryResourceForPull(resourceId)).toEqual(
        expect.objectContaining({
          id: resourceId,
          kind: "template",
          targets: ["website"],
          source: expect.objectContaining({
            path: item.sourcePath,
            archive: {
              type: "tar.gz",
              sha256: EXPECTED_WEBSITE_TEMPLATE_V2_SHA256[item.slug],
            },
          }),
        }),
      );
    }
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
