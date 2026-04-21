/**
 * Tests for zero web upload-file command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): backend prepare route + R2 PUT via MSW
 * - Real (internal): All CLI code, fetch, filesystem reads
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { uploadFileCommand } from "../upload-file";
import chalk from "chalk";

const PREPARE_URL = "http://localhost:3000/api/zero/uploads/prepare";
const PUT_URL = "https://mock-r2.test/upload-target";

describe("zero web upload-file command", () => {
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

    tmpDir = join(tmpdir(), `web-upload-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("successful upload", () => {
    it("should prepare + PUT and print JSON result", async () => {
      const filePath = join(tmpDir, "report.pdf");
      writeFileSync(filePath, Buffer.from("%PDF-1.4 fake"));

      const prepared = {
        id: "file-uuid-1",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
        uploadUrl: PUT_URL,
        url: "https://presigned.example.com/file-uuid-1/report.pdf?sig=abc",
      };

      let putReceivedContentType: string | null = null;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(request.headers.get("content-type")).toBe("application/json");

          const body = (await request.json()) as {
            filename: string;
            contentType: string;
            size: number;
          };
          expect(body.filename).toBe("report.pdf");
          expect(body.contentType).toBe("application/pdf");
          expect(body.size).toBe(13);

          return HttpResponse.json(prepared, { status: 200 });
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          return new HttpResponse(null, { status: 200 });
        }),
      );

      await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);

      expect(putReceivedContentType).toBe("application/pdf");
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        id: "file-uuid-1",
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
        url: prepared.url,
      });
    });

    it("should respect --content-type override", async () => {
      const filePath = join(tmpDir, "data.bin");
      writeFileSync(filePath, Buffer.from("col1,col2\n1,2"));

      let putReceivedContentType: string | null = null;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as { contentType: string };
          expect(body.contentType).toBe("text/csv");

          return HttpResponse.json(
            {
              id: "csv-uuid",
              filename: "data.bin",
              contentType: "text/csv",
              size: 13,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/csv-uuid/data.bin?sig=xyz",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          return new HttpResponse(null, { status: 200 });
        }),
      );

      await uploadFileCommand.parseAsync([
        "node",
        "cli",
        "-f",
        filePath,
        "--content-type",
        "text/csv",
      ]);

      expect(putReceivedContentType).toBe("text/csv");
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.contentType).toBe("text/csv");
    });
  });

  describe("validation errors", () => {
    it("should throw when the file does not exist", async () => {
      await expect(async () => {
        await uploadFileCommand.parseAsync([
          "node",
          "cli",
          "-f",
          join(tmpDir, "missing.txt"),
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("API errors", () => {
    it("should surface 401 unauthorized from prepare", async () => {
      const filePath = join(tmpDir, "hello.txt");
      writeFileSync(filePath, "hi");

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Not authenticated"),
      );
    });

    it("should surface 400 file too large from prepare", async () => {
      const filePath = join(tmpDir, "big.txt");
      writeFileSync(filePath, "small");

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "File too large (max 1 GB)",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("File too large"),
      );
    });

    it("should surface failure from R2 PUT", async () => {
      const filePath = join(tmpDir, "bad.txt");
      writeFileSync(filePath, "oops");

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              id: "bad-id",
              filename: "bad.txt",
              contentType: "text/plain",
              size: 4,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/bad-id/bad.txt",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to upload file to storage"),
      );
    });
  });
});
