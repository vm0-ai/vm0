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
const COMPLETE_URL = "http://localhost:3000/api/zero/uploads/complete";
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
    it("should prepare + PUT + complete and print JSON result", async () => {
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
      let completed = false;

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
        http.post(COMPLETE_URL, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-token",
          );
          expect(await request.json()).toEqual({
            id: prepared.id,
            contentType: prepared.contentType,
          });
          completed = true;
          return HttpResponse.json({
            id: prepared.id,
            filename: prepared.filename,
            contentType: prepared.contentType,
            size: prepared.size,
            url: prepared.url,
          });
        }),
      );

      await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);

      expect(putReceivedContentType).toBe("application/pdf");
      expect(completed).toBe(true);
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
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json({
            id: "csv-uuid",
            filename: "data.bin",
            contentType: "text/csv",
            size: 13,
            url: "https://presigned.example.com/csv-uuid/data.bin?sig=xyz",
          });
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

    it("should infer text/html for html files", async () => {
      const filePath = join(tmpDir, "preview.html");
      writeFileSync(filePath, "<!doctype html><title>Preview</title>");

      let putReceivedContentType: string | null = null;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            filename: string;
            contentType: string;
          };
          expect(body.filename).toBe("preview.html");
          expect(body.contentType).toBe("text/html");

          return HttpResponse.json(
            {
              id: "html-uuid",
              filename: "preview.html",
              contentType: "text/html",
              size: 37,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/html-uuid/preview.html",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json({
            id: "html-uuid",
            filename: "preview.html",
            contentType: "text/html",
            size: 37,
            url: "https://presigned.example.com/html-uuid/preview.html",
          });
        }),
      );

      await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);

      expect(putReceivedContentType).toBe("text/html");
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.contentType).toBe("text/html");
    });

    it.each([
      ["image.avif", "image/avif"],
      ["clip.mp3", "audio/mpeg"],
      ["voice.wav", "audio/wav"],
    ])("should infer %s as %s", async (filename, expectedContentType) => {
      const filePath = join(tmpDir, filename);
      writeFileSync(filePath, Buffer.from("fake bytes"));

      let putReceivedContentType: string | null = null;

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            filename: string;
            contentType: string;
          };
          expect(body.filename).toBe(filename);
          expect(body.contentType).toBe(expectedContentType);

          return HttpResponse.json(
            {
              id: `${filename}-uuid`,
              filename,
              contentType: expectedContentType,
              size: 10,
              uploadUrl: PUT_URL,
              url: `https://presigned.example.com/${filename}`,
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, ({ request }) => {
          putReceivedContentType = request.headers.get("content-type");
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json({
            id: `${filename}-uuid`,
            filename,
            contentType: expectedContentType,
            size: 10,
            url: `https://presigned.example.com/${filename}`,
          });
        }),
      );

      await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);

      expect(putReceivedContentType).toBe(expectedContentType);
      const stdout = mockConsoleLog.mock.calls.flat().join("\n");
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.contentType).toBe(expectedContentType);
    });

    it("should infer office content types from common extensions", async () => {
      const cases = [
        {
          filename: "brief.docx",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
        {
          filename: "budget.xlsx",
          contentType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        {
          filename: "deck.pptx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      ] as const;
      const preparedById = new Map<
        string,
        { filename: string; contentType: string; size: number }
      >();
      const preparedBodies: Array<{ filename: string; contentType: string }> =
        [];

      server.use(
        http.post(PREPARE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            filename: string;
            contentType: string;
            size: number;
          };
          const id = `${body.filename}-uuid`;
          preparedBodies.push({
            filename: body.filename,
            contentType: body.contentType,
          });
          preparedById.set(id, {
            filename: body.filename,
            contentType: body.contentType,
            size: body.size,
          });

          return HttpResponse.json(
            {
              id,
              filename: body.filename,
              contentType: body.contentType,
              size: body.size,
              uploadUrl: PUT_URL,
              url: `https://presigned.example.com/${body.filename}`,
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, async ({ request }) => {
          const body = (await request.json()) as {
            id: string;
            contentType: string;
          };
          const prepared = preparedById.get(body.id);
          if (!prepared) {
            throw new Error(`missing prepared upload for ${body.id}`);
          }
          expect(body.contentType).toBe(prepared.contentType);
          return HttpResponse.json({
            id: body.id,
            filename: prepared.filename,
            contentType: prepared.contentType,
            size: prepared.size,
            url: `https://presigned.example.com/${prepared.filename}`,
          });
        }),
      );

      for (const { filename } of cases) {
        const filePath = join(tmpDir, filename);
        writeFileSync(filePath, Buffer.from("office"));

        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }

      expect(preparedBodies).toEqual(cases);
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
      let completeCalled = false;

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
        http.post(COMPLETE_URL, () => {
          completeCalled = true;
          return HttpResponse.json({});
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to upload file to storage"),
      );
      expect(completeCalled).toBe(false);
    });

    it("should surface failure from complete", async () => {
      const filePath = join(tmpDir, "complete-fails.txt");
      writeFileSync(filePath, "done");

      server.use(
        http.post(PREPARE_URL, () => {
          return HttpResponse.json(
            {
              id: "complete-id",
              filename: "complete-fails.txt",
              contentType: "text/plain",
              size: 4,
              uploadUrl: PUT_URL,
              url: "https://presigned.example.com/complete-id/complete-fails.txt",
            },
            { status: 200 },
          );
        }),
        http.put(PUT_URL, () => {
          return new HttpResponse(null, { status: 200 });
        }),
        http.post(COMPLETE_URL, () => {
          return HttpResponse.json(
            {
              error: {
                message: "Uploaded file not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        }),
      );

      await expect(async () => {
        await uploadFileCommand.parseAsync(["node", "cli", "-f", filePath]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Uploaded file not found"),
      );
    });
  });
});
