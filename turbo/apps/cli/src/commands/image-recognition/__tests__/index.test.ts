import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  IMAGE_RECOGNITION_MAX_FILE_BYTES,
  IMAGE_RECOGNITION_MAX_PROMPT_CHARS,
} from "@okouai/api-contracts/contracts/image-recognition";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../mocks/server";
import {
  imageRecognitionCommand,
  imageRecognitionCompatibilityCommand,
} from "../index";

const PREPARE_URL = "http://localhost:3000/api/uploads/prepare";
const COMPLETE_URL = "http://localhost:3000/api/uploads/complete";
const IMAGE_RECOGNITION_URL = "http://localhost:3000/api/image-recognition";
const PUT_URL = "https://mock-r2.test/recognition-upload";

function installUploadHandlers(fileId: string, filename: string, size: number) {
  server.use(
    http.post(PREPARE_URL, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      await expect(request.json()).resolves.toMatchObject({
        filename,
        contentType: "image/png",
        size,
      });
      return HttpResponse.json({
        id: fileId,
        filename,
        contentType: "image/png",
        size,
        uploadUrl: PUT_URL,
        uploadHeaders: { "x-amz-meta-artifact-id": fileId },
        url: `https://cdn.example.test/${fileId}/${filename}`,
      });
    }),
    http.put(PUT_URL, ({ request }) => {
      expect(request.headers.get("content-type")).toBe("image/png");
      expect(request.headers.get("x-amz-meta-artifact-id")).toBe(fileId);
      return new HttpResponse(null, { status: 200 });
    }),
    http.post(COMPLETE_URL, async ({ request }) => {
      await expect(request.json()).resolves.toStrictEqual({
        id: fileId,
        contentType: "image/png",
      });
      return HttpResponse.json({
        id: fileId,
        filename,
        contentType: "image/png",
        size,
        url: `https://cdn.example.test/${fileId}/${filename}`,
      });
    }),
  );
}

const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
  return undefined as never;
});
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});
let tempDir: string;

beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_TOKEN", "test-token");
  tempDir = join(tmpdir(), `image-recognition-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("okou image-recognition command", () => {
  it("uploads one image, recognizes it, and prints only text", async () => {
    const fileId = randomUUID();
    const filePath = join(tempDir, "screen.png");
    const bytes = Buffer.from("fake-png-bytes");
    writeFileSync(filePath, bytes);
    installUploadHandlers(fileId, "screen.png", bytes.length);
    let imageRecognitionCalls = 0;
    server.use(
      http.post(IMAGE_RECOGNITION_URL, async ({ request }) => {
        imageRecognitionCalls += 1;
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        await expect(request.json()).resolves.toStrictEqual({
          fileId,
          prompt: "Read the error message",
        });
        return HttpResponse.json({
          text: "The dialog says access denied.",
          metadata: { creditsCharged: 7 },
        });
      }),
    );

    await imageRecognitionCommand.parseAsync([
      "node",
      "okou",
      "--file",
      filePath,
      "--prompt",
      "  Read the error message  ",
    ]);

    expect(imageRecognitionCalls).toBe(1);
    expect(mockConsoleLog.mock.calls).toStrictEqual([
      ["The dialog says access denied."],
    ]);
    expect(mockConsoleError).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("rejects invalid local inputs before upload", async () => {
    const empty = join(tempDir, "empty.png");
    const missing = join(tempDir, "missing.png");
    const unsupported = join(tempDir, "animation.gif");
    const oversized = join(tempDir, "large.webp");
    writeFileSync(empty, Buffer.alloc(0));
    writeFileSync(unsupported, "gif");
    writeFileSync(oversized, "x");
    truncateSync(oversized, IMAGE_RECOGNITION_MAX_FILE_BYTES + 1);
    let networkCalled = false;
    server.use(
      http.post(PREPARE_URL, () => {
        networkCalled = true;
        return HttpResponse.json({});
      }),
      http.post(IMAGE_RECOGNITION_URL, () => {
        networkCalled = true;
        return HttpResponse.json({});
      }),
    );

    const invalidInputs = [
      { file: missing, prompt: "describe", message: "no such file" },
      { file: tempDir, prompt: "describe", message: "Not a regular file" },
      { file: empty, prompt: "describe", message: "must not be empty" },
      {
        file: unsupported,
        prompt: "describe",
        message: "PNG, JPEG, or WebP",
      },
      { file: oversized, prompt: "describe", message: "20 MB or smaller" },
      {
        file: unsupported,
        prompt: "   ",
        message: "prompt must not be empty",
      },
      {
        file: unsupported,
        prompt: "x".repeat(IMAGE_RECOGNITION_MAX_PROMPT_CHARS + 1),
        message: "characters or fewer",
      },
    ] as const;

    for (const input of invalidInputs) {
      mockConsoleError.mockClear();
      await imageRecognitionCommand.parseAsync([
        "node",
        "okou",
        "--file",
        input.file,
        "--prompt",
        input.prompt,
      ]);
      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        input.message,
      );
    }
    expect(networkCalled).toBe(false);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("prints API failures to stderr without printing billing metadata", async () => {
    const fileId = randomUUID();
    const filePath = join(tempDir, "screen.png");
    writeFileSync(filePath, "png");
    installUploadHandlers(fileId, "screen.png", 3);
    server.use(
      http.post(IMAGE_RECOGNITION_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Image recognition is temporarily unavailable",
              code: "PROVIDER_UNAVAILABLE",
            },
          },
          { status: 503 },
        );
      }),
    );

    await imageRecognitionCommand.parseAsync([
      "node",
      "okou",
      "--file",
      filePath,
      "--prompt",
      "describe",
    ]);

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "temporarily unavailable",
    );
    expect(mockConsoleError.mock.calls.flat().join("\n")).not.toContain(
      "creditsCharged",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exposes no model, retry, JSON, or billing options", () => {
    const optionNames = imageRecognitionCommand.options.map((option) => {
      return option.attributeName();
    });
    expect(optionNames).toStrictEqual(["file", "prompt"]);
  });

  it("uses the canonical command name and Okou branding in help", () => {
    let helpOutput = "";
    imageRecognitionCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    imageRecognitionCommand.outputHelp();

    expect(helpOutput).toContain("okou image-recognition --file");
    expect(helpOutput).not.toContain("okou recognize --file");
    expect(helpOutput).toContain("Uses a fixed Okou-managed recognition model");
  });
});

describe("okou recognize compatibility command", () => {
  it("keeps okou recognize on the compatibility API path", async () => {
    const fileId = randomUUID();
    const filePath = join(tempDir, "compatibility.png");
    const bytes = Buffer.from("compatibility-png");
    writeFileSync(filePath, bytes);
    installUploadHandlers(fileId, "compatibility.png", bytes.length);
    let compatibilityCalls = 0;
    let canonicalCalls = 0;
    server.use(
      http.post("http://localhost:3000/api/recognize", async ({ request }) => {
        compatibilityCalls += 1;
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        await expect(request.json()).resolves.toStrictEqual({
          fileId,
          prompt: "Read the compatibility image",
        });
        return HttpResponse.json({
          text: "Compatibility result",
          metadata: { creditsCharged: 7 },
        });
      }),
      http.post(IMAGE_RECOGNITION_URL, () => {
        canonicalCalls += 1;
        return HttpResponse.json({
          text: "Canonical result",
          metadata: { creditsCharged: 7 },
        });
      }),
    );

    await imageRecognitionCompatibilityCommand.parseAsync([
      "node",
      "okou",
      "--file",
      filePath,
      "--prompt",
      "  Read the compatibility image  ",
    ]);

    expect(compatibilityCalls).toBe(1);
    expect(canonicalCalls).toBe(0);
    expect(mockConsoleLog.mock.calls).toStrictEqual([["Compatibility result"]]);
    expect(mockConsoleError).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("keeps compatibility validation ahead of upload", async () => {
    const missing = join(tempDir, "missing.png");
    let networkCalled = false;
    server.use(
      http.post(PREPARE_URL, () => {
        networkCalled = true;
        return HttpResponse.json({});
      }),
      http.post("http://localhost:3000/api/recognize", () => {
        networkCalled = true;
        return HttpResponse.json({});
      }),
    );

    await imageRecognitionCompatibilityCommand.parseAsync([
      "node",
      "okou",
      "--file",
      missing,
      "--prompt",
      "describe",
    ]);

    expect(networkCalled).toBe(false);
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "no such file",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("bounds compatibility help to the canonical command", () => {
    let helpOutput = "";
    imageRecognitionCompatibilityCommand.configureOutput({
      writeOut: (text: string) => {
        helpOutput += text;
      },
    });

    imageRecognitionCompatibilityCommand.outputHelp();

    expect(helpOutput).toContain(
      "Compatibility command for okou image-recognition",
    );
    expect(helpOutput).toContain(
      "Use okou image-recognition for new invocations",
    );
    expect(helpOutput).toContain("okou recognize --file");
  });
});
