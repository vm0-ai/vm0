import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  testContext,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { generateZeroToken } from "../../../../../../src/lib/auth/sandbox-token";

const context = testContext();

function createPrepareRequest(
  body: unknown,
  opts: { authToken?: string; unauthenticated?: boolean } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.unauthenticated) {
    headers["x-no-auth"] = "true";
  }
  if (opts.authToken) {
    headers["authorization"] = `Bearer ${opts.authToken}`;
  }
  return new NextRequest("http://localhost:3000/api/zero/uploads/prepare", {
    method: "POST",
    body: body === undefined ? null : JSON.stringify(body),
    headers,
  });
}

describe("POST /api/zero/uploads/prepare", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("Authentication", () => {
    it("rejects unauthenticated requests", async () => {
      mockClerk({ userId: null });
      const response = await POST(
        createPrepareRequest(
          { filename: "a.png", contentType: "image/png", size: 1 },
          { unauthenticated: true },
        ),
      );
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("UNAUTHORIZED");
    });

    it("accepts ZERO_TOKEN with file:write capability", async () => {
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);
      const response = await POST(
        createPrepareRequest(
          { filename: "hello.txt", contentType: "text/plain", size: 5 },
          { authToken: token },
        ),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.uploadUrl).toBeTypeOf("string");
      expect(body.url).toBeTypeOf("string");
      expect(body.id).toBeTypeOf("string");
    });
  });

  describe("Validation", () => {
    it("rejects invalid body shape", async () => {
      const response = await POST(createPrepareRequest({ filename: "" }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("BAD_REQUEST");
    });

    it("rejects files larger than 1 GB", async () => {
      const response = await POST(
        createPrepareRequest({
          filename: "big.bin",
          contentType: "application/pdf",
          size: 1024 * 1024 * 1024 + 1,
        }),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.message).toContain("File too large");
    });

    it("rejects unsupported content types", async () => {
      const response = await POST(
        createPrepareRequest({
          filename: "bad.exe",
          contentType: "application/x-msdownload",
          size: 10,
        }),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.message).toContain("Unsupported file type");
    });
  });

  describe("Success", () => {
    it("returns presigned upload URL and final GET URL", async () => {
      const response = await POST(
        createPrepareRequest({
          filename: "hello.txt",
          contentType: "text/plain",
          size: 13,
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        filename: "hello.txt",
        contentType: "text/plain",
        size: 13,
      });
      expect(body.uploadUrl).toMatch(/^https?:\/\//);
      expect(body.url).toMatch(/^https?:\/\//);
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("accepts image/avif uploads", async () => {
      const response = await POST(
        createPrepareRequest({
          filename: "screenshot.avif",
          contentType: "image/avif",
          size: 4096,
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        filename: "screenshot.avif",
        contentType: "image/avif",
      });
    });

    it("accepts html uploads for controlled chat preview flows", async () => {
      const response = await POST(
        createPrepareRequest({
          filename: "report.html",
          contentType: "text/html",
          size: 2048,
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        filename: "report.html",
        contentType: "text/html",
      });
    });

    it("accepts audio uploads for chat preview flows", async () => {
      const response = await POST(
        createPrepareRequest({
          filename: "clip.mp3",
          contentType: "audio/mpeg",
          size: 4096,
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        filename: "clip.mp3",
        contentType: "audio/mpeg",
      });
    });

    it("accepts common office document uploads", async () => {
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

      for (const { filename, contentType } of cases) {
        const response = await POST(
          createPrepareRequest({
            filename,
            contentType,
            size: 4096,
          }),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ filename, contentType });
      }
    });

    it("accepts additional common document and archive uploads", async () => {
      const cases = [
        { filename: "archive.zip", contentType: "application/zip" },
        {
          filename: "backup.7z",
          contentType: "application/x-7z-compressed",
        },
        { filename: "bundle.tar", contentType: "application/x-tar" },
        { filename: "bundle.tgz", contentType: "application/gzip" },
        { filename: "design.psd", contentType: "image/vnd.adobe.photoshop" },
        { filename: "vector.ai", contentType: "application/postscript" },
        { filename: "photo.heic", contentType: "image/heic" },
        { filename: "scan.tiff", contentType: "image/tiff" },
        {
          filename: "document.pages",
          contentType: "application/vnd.apple.pages",
        },
        {
          filename: "sheet.numbers",
          contentType: "application/vnd.apple.numbers",
        },
        {
          filename: "slides.key",
          contentType: "application/vnd.apple.keynote",
        },
        {
          filename: "macro.xlsm",
          contentType: "application/vnd.ms-excel.sheet.macroenabled.12",
        },
        {
          filename: "template.potx",
          contentType:
            "application/vnd.openxmlformats-officedocument.presentationml.template",
        },
        { filename: "data.xml", contentType: "application/xml" },
        { filename: "config.yaml", contentType: "application/yaml" },
        { filename: "table.tsv", contentType: "text/tab-separated-values" },
        {
          filename: "events.parquet",
          contentType: "application/vnd.apache.parquet",
        },
        { filename: "local.sqlite", contentType: "application/vnd.sqlite3" },
        { filename: "book.epub", contentType: "application/epub+zip" },
      ] as const;

      for (const { filename, contentType } of cases) {
        const response = await POST(
          createPrepareRequest({
            filename,
            contentType,
            size: 4096,
          }),
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ filename, contentType });
      }
    });

    it("sanitizes filenames when building the S3 key", async () => {
      const response = await POST(
        createPrepareRequest({
          filename: "my file (1).txt",
          contentType: "text/plain",
          size: 10,
        }),
      );
      expect(response.status).toBe(200);

      // Underlying helpers are mocked to return static strings, so we assert
      // on the S3 key that the route passed to them.
      const putCall = context.mocks.s3.generatePresignedPutUrl.mock.calls[0];
      const putKey = putCall?.[1];
      expect(putKey).toContain("my_file__1_.txt");
      expect(putKey).toContain(`uploads/${user.userId}/`);
    });
  });
});
