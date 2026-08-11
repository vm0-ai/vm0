import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroPresentationTemplateCommand } from "../index";

const TEMPLATE_ID = "00000000-0000-4000-8000-000000000123";
const API_ROOT = `http://localhost:3000/api/zero/presentation-templates/${TEMPLATE_ID}`;
const SOURCE_URL = "https://downloads.example.test/source.pptx";
const PACKAGE_URL = "https://downloads.example.test/package.tar.gz";

interface TarEntry {
  readonly path: string;
  readonly content: string;
}

function writeOctal(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  buffer.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function tarHeader(entry: TarEntry): Buffer {
  const content = Buffer.from(entry.content, "utf8");
  const header = Buffer.alloc(512);
  header.write(entry.path, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => {
    return total + byte;
  }, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function tarGz(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    chunks.push(tarHeader(entry), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function png(): Buffer {
  return Buffer.from("\x89PNG\r\n\x1a\n", "latin1");
}

describe("zero presentation-template", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let testDir: string;

  beforeEach(async () => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-zero-token");
    testDir = await mkdtemp(
      path.join(tmpdir(), "zero-presentation-template-test-"),
    );
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(testDir, { recursive: true, force: true });
  });

  it("downloads the PPTX source to the requested path", async () => {
    const source = Buffer.from("pptx-source", "utf8");
    server.use(
      http.get(`${API_ROOT}/source`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-zero-token",
        );
        return HttpResponse.json({
          url: SOURCE_URL,
          filename: "source.pptx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          size: source.length,
        });
      }),
      http.get(SOURCE_URL, () => {
        return new HttpResponse(source);
      }),
    );
    const outputPath = path.join(testDir, "nested", "source.pptx");

    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "zero",
      "source",
      "--id",
      TEMPLATE_ID,
      "--out",
      outputPath,
    ]);

    expect(await readFile(outputPath)).toEqual(source);
  });

  it("uploads PNG pages in numeric filename order and commits their keys", async () => {
    const pagesDir = path.join(testDir, "pages");
    await Promise.all([
      writeFile(path.join(testDir, "page-1.png"), png()),
      writeFile(path.join(testDir, "page-2.png"), png()),
      writeFile(path.join(testDir, "page-10.png"), png()),
    ]);
    await mkdir(pagesDir);
    await Promise.all([
      rename(
        path.join(testDir, "page-1.png"),
        path.join(pagesDir, "page-1.png"),
      ),
      rename(
        path.join(testDir, "page-2.png"),
        path.join(pagesDir, "page-2.png"),
      ),
      rename(
        path.join(testDir, "page-10.png"),
        path.join(pagesDir, "page-10.png"),
      ),
    ]);
    const uploaded: string[] = [];
    server.use(
      http.post(`${API_ROOT}/pages/prepare`, async ({ request }) => {
        expect(await request.json()).toEqual({ count: 3 });
        return HttpResponse.json({
          uploads: [1, 2, 10].map((page) => {
            return {
              key: `page-key-${page.toString()}`,
              uploadUrl: `https://uploads.example.test/${page.toString()}`,
              uploadHeaders: { "x-amz-meta-page": page.toString() },
            };
          }),
        });
      }),
      http.put(
        "https://uploads.example.test/:page",
        async ({ params, request }) => {
          uploaded.push(String(params.page));
          expect(request.headers.get("content-type")).toBe("image/png");
          expect(request.headers.get("x-amz-meta-page")).toBe(
            String(params.page),
          );
          expect(Buffer.from(await request.arrayBuffer())).toEqual(png());
          return new HttpResponse(null, { status: 200 });
        },
      ),
      http.post(`${API_ROOT}/pages/commit`, async ({ request }) => {
        expect(await request.json()).toEqual({
          keys: ["page-key-1", "page-key-2", "page-key-10"],
          aspectRatio: 16 / 9,
        });
        return HttpResponse.json({ id: TEMPLATE_ID, status: "processing" });
      }),
    );

    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "zero",
      "pages",
      "upload",
      "--id",
      TEMPLATE_ID,
      "--dir",
      pagesDir,
    ]);

    expect(uploaded).toEqual(["1", "2", "10"]);
  });

  it("does not commit the page batch when one upload fails", async () => {
    const pagesDir = path.join(testDir, "pages");
    await mkdir(pagesDir);
    await Promise.all([
      writeFile(path.join(pagesDir, "page-1.png"), png()),
      writeFile(path.join(pagesDir, "page-2.png"), png()),
    ]);
    let commitRequests = 0;
    server.use(
      http.post(`${API_ROOT}/pages/prepare`, () => {
        return HttpResponse.json({
          uploads: [1, 2].map((page) => {
            return {
              key: `page-key-${page.toString()}`,
              uploadUrl: `https://uploads.example.test/${page.toString()}`,
              uploadHeaders: {},
            };
          }),
        });
      }),
      http.put("https://uploads.example.test/1", () => {
        return new HttpResponse(null, { status: 200 });
      }),
      http.put("https://uploads.example.test/2", () => {
        return new HttpResponse(null, { status: 500 });
      }),
      http.post(`${API_ROOT}/pages/commit`, () => {
        commitRequests += 1;
        return HttpResponse.json({ id: TEMPLATE_ID, status: "processing" });
      }),
    );

    await expect(
      zeroPresentationTemplateCommand.parseAsync([
        "node",
        "zero",
        "pages",
        "upload",
        "--id",
        TEMPLATE_ID,
        "--dir",
        pagesDir,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(commitRequests).toBe(0);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Page upload failed for page-2.png: 500",
    );
  });

  it("publishes exactly the three required package files", async () => {
    const packageDir = path.join(testDir, "package");
    await mkdir(packageDir);
    await Promise.all([
      writeFile(path.join(packageDir, "DESIGN_SYSTEM.md"), "design"),
      writeFile(path.join(packageDir, "LAYOUTS.md"), "layouts"),
      writeFile(path.join(packageDir, "tokens.json"), '{"colors":{}}'),
    ]);
    server.use(
      http.post(`${API_ROOT}/package`, async ({ request }) => {
        expect(await request.json()).toEqual({
          files: [
            { path: "DESIGN_SYSTEM.md", content: "design" },
            { path: "LAYOUTS.md", content: "layouts" },
            { path: "tokens.json", content: '{"colors":{}}' },
          ],
        });
        return HttpResponse.json({ id: TEMPLATE_ID, status: "ready" });
      }),
    );

    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "zero",
      "publish",
      "--id",
      TEMPLATE_ID,
      "--dir",
      packageDir,
    ]);
  });

  it("reports a stable import failure", async () => {
    server.use(
      http.post(`${API_ROOT}/fail`, async ({ request }) => {
        expect(await request.json()).toEqual({
          code: "render_failed",
          message: "LibreOffice failed",
        });
        return HttpResponse.json({ id: TEMPLATE_ID, status: "failed" });
      }),
    );

    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "zero",
      "fail",
      "--id",
      TEMPLATE_ID,
      "--code",
      "render_failed",
      "--message",
      "LibreOffice failed",
    ]);
  });

  it("downloads, verifies, and extracts a user template package", async () => {
    const archive = tarGz([
      { path: "DESIGN_SYSTEM.md", content: "design" },
      { path: "LAYOUTS.md", content: "layouts" },
      { path: "tokens.json", content: '{"colors":{}}' },
    ]);
    server.use(
      http.get(`${API_ROOT}/package`, () => {
        return HttpResponse.json({ url: PACKAGE_URL, sha256: sha256(archive) });
      }),
      http.get(PACKAGE_URL, () => {
        return new HttpResponse(archive);
      }),
    );
    const outputDir = path.join(testDir, "pulled");

    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "zero",
      "pull",
      `user-template:${TEMPLATE_ID}`,
      "--dir",
      outputDir,
    ]);

    expect(
      await readFile(path.join(outputDir, "DESIGN_SYSTEM.md"), "utf8"),
    ).toBe("design");
  });

  it("rejects a package whose bytes do not match the API digest", async () => {
    const archive = tarGz([{ path: "tokens.json", content: "{}" }]);
    server.use(
      http.get(`${API_ROOT}/package`, () => {
        return HttpResponse.json({ url: PACKAGE_URL, sha256: sha256(archive) });
      }),
      http.get(PACKAGE_URL, () => {
        return new HttpResponse(Buffer.from("wrong archive", "utf8"));
      }),
    );

    await expect(
      zeroPresentationTemplateCommand.parseAsync([
        "node",
        "zero",
        "pull",
        `user-template:${TEMPLATE_ID}`,
        "--dir",
        path.join(testDir, "digest-mismatch"),
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Presentation template package archive digest mismatch",
    );
  });

  it("refuses package archive paths outside the destination", async () => {
    const archive = tarGz([{ path: "../escape.txt", content: "escape" }]);
    server.use(
      http.get(`${API_ROOT}/package`, () => {
        return HttpResponse.json({ url: PACKAGE_URL, sha256: sha256(archive) });
      }),
      http.get(PACKAGE_URL, () => {
        return new HttpResponse(archive);
      }),
    );
    const outputDir = path.join(testDir, "unsafe");

    await expect(
      zeroPresentationTemplateCommand.parseAsync([
        "node",
        "zero",
        "pull",
        `user-template:${TEMPLATE_ID}`,
        "--dir",
        outputDir,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "contains unsafe path: ../escape.txt",
    );
    await expect(access(path.join(testDir, "escape.txt"))).rejects.toThrow();
  });

  it("surfaces API error messages without replacing them", async () => {
    server.use(
      http.get(`${API_ROOT}/source`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Presentation template source is gone",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(
      zeroPresentationTemplateCommand.parseAsync([
        "node",
        "zero",
        "source",
        "--id",
        TEMPLATE_ID,
        "--out",
        path.join(testDir, "missing.pptx"),
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Presentation template source is gone",
    );
  });
});
