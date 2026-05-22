import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { downloadFileCommand } from "../download-file";
import chalk from "chalk";

const DOWNLOAD_URL =
  "http://localhost:3000/api/zero/integrations/github/download-file";

describe("zero github download-file command", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let tmpDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    tmpDir = join(tmpdir(), `github-download-file-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("streams file bytes to the provided output path and prints JSON result", async () => {
    const payload = Buffer.from("hello github");
    const outPath = join(tmpDir, "screenshot.png");
    const fileUrl = "https://github.com/user-attachments/assets/abc123";

    server.use(
      http.get(DOWNLOAD_URL, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("url")).toBe(fileUrl);
        expect(url.searchParams.get("filename")).toBe("screenshot.png");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return new HttpResponse(payload, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(payload.length),
            "x-file-mimetype": "image/png",
          },
        });
      }),
    );

    await downloadFileCommand.parseAsync([
      "node",
      "cli",
      fileUrl,
      "--filename",
      "screenshot.png",
      "-o",
      outPath,
    ]);

    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).equals(payload)).toBe(true);

    const stdout = mockConsoleLog.mock.calls.flat().join("\n");
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      path: outPath,
      mimetype: "image/png",
      size: payload.length,
    });
  });

  it("surfaces API errors", async () => {
    server.use(
      http.get(DOWNLOAD_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "No GitHub installation found",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      }),
    );

    await expect(async () => {
      await downloadFileCommand.parseAsync([
        "node",
        "cli",
        "https://github.com/user-attachments/assets/missing",
        "-o",
        join(tmpDir, "missing.bin"),
      ]);
    }).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("No GitHub installation found"),
    );
  });
});
