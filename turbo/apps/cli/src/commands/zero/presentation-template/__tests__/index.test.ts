import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpResponse, http } from "msw";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../../mocks/server";
import { zeroPresentationTemplateCommand } from "../index";

const TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const API_ROOT = `http://localhost:3000/api/okou/presentation-templates/${TEMPLATE_ID}`;
const SOURCE_URL = "https://r2.example.test/template-source";
const PAGE_UPLOAD_URLS = [
  "https://r2.example.test/template-page-1",
  "https://r2.example.test/template-page-2",
] as const;

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("okou presentation-template command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
    return undefined as never;
  });
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let tempDir: string;

  beforeEach(() => {
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    tempDir = mkdtempSync(join(tmpdir(), "zero-presentation-template-"));
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mockExit.mockRestore();
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
  });

  it("downloads source, uploads ordered pages, publishes a package, and reports failure", async () => {
    const sourceBytes = Buffer.from("pptx-source");
    const uploadedPages: Buffer[] = [];
    const pageKeys = ["templates/page-001.png", "templates/page-002.png"];
    let commitBody: unknown;
    let packageBody: unknown;
    let failureBody: unknown;

    server.use(
      http.get(`${API_ROOT}/source`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return HttpResponse.json({
          url: SOURCE_URL,
          filename: "source.pptx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          size: sourceBytes.length,
        });
      }),
      http.get(SOURCE_URL, () => {
        return new HttpResponse(new Uint8Array(sourceBytes), { status: 200 });
      }),
      http.post(`${API_ROOT}/pages/prepare`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        await expect(request.json()).resolves.toStrictEqual({ count: 2 });
        return HttpResponse.json({
          uploads: pageKeys.map((key, index) => {
            return {
              key,
              uploadUrl: PAGE_UPLOAD_URLS[index],
              uploadHeaders: { "x-amz-meta-page": (index + 1).toString() },
            };
          }),
        });
      }),
      ...PAGE_UPLOAD_URLS.map((url, index) => {
        return http.put(url, async ({ request }) => {
          expect(request.headers.get("content-type")).toBe("image/png");
          expect(request.headers.get("x-amz-meta-page")).toBe(
            (index + 1).toString(),
          );
          uploadedPages[index] = Buffer.from(await request.arrayBuffer());
          return new HttpResponse(null, { status: 200 });
        });
      }),
      http.post(`${API_ROOT}/pages/commit`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        commitBody = await request.json();
        return HttpResponse.json({ id: TEMPLATE_ID, status: "processing" });
      }),
      http.post(`${API_ROOT}/package`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        packageBody = await request.json();
        return HttpResponse.json({ id: TEMPLATE_ID, status: "ready" });
      }),
      http.post(`${API_ROOT}/fail`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        failureBody = await request.json();
        return HttpResponse.json({ id: TEMPLATE_ID, status: "failed" });
      }),
    );

    const sourcePath = join(tempDir, "source");
    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "okou",
      "source",
      "--id",
      TEMPLATE_ID,
      "--out",
      sourcePath,
    ]);
    expect(readFileSync(sourcePath)).toStrictEqual(sourceBytes);

    const pagesDir = join(tempDir, "pages");
    mkdirSync(pagesDir);
    const firstPage = pngHeader(1600, 900);
    const secondPage = pngHeader(1600, 900);
    writeFileSync(join(pagesDir, "page-2.png"), secondPage);
    writeFileSync(join(pagesDir, "page-1.png"), firstPage);
    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "okou",
      "pages",
      "upload",
      "--id",
      TEMPLATE_ID,
      "--dir",
      pagesDir,
    ]);
    expect(uploadedPages).toStrictEqual([firstPage, secondPage]);
    expect(commitBody).toStrictEqual({
      keys: pageKeys,
      aspectRatio: 16 / 9,
    });

    const packageDir = join(tempDir, "package");
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, "DESIGN_SYSTEM.md"), "# Design system");
    writeFileSync(join(packageDir, "LAYOUTS.md"), "# Layouts");
    writeFileSync(join(packageDir, "tokens.json"), '{"colors":{}}');
    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "okou",
      "publish",
      "--id",
      TEMPLATE_ID,
      "--dir",
      packageDir,
    ]);
    expect(packageBody).toStrictEqual({
      files: [
        { path: "DESIGN_SYSTEM.md", content: "# Design system" },
        { path: "LAYOUTS.md", content: "# Layouts" },
        { path: "tokens.json", content: '{"colors":{}}' },
      ],
    });

    await zeroPresentationTemplateCommand.parseAsync([
      "node",
      "okou",
      "fail",
      "--id",
      TEMPLATE_ID,
      "--code",
      "analysis_failed",
      "--message",
      "  extraction failed  ",
    ]);
    expect(failureBody).toStrictEqual({
      code: "analysis_failed",
      message: "extraction failed",
    });
    expect(mockConsoleError).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });
});
