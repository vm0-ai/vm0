import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  testContext,
  type UserContext,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import {
  generateZeroToken,
  generateSandboxToken,
} from "../../../../../src/lib/auth/sandbox-token";

const context = testContext();

function createUploadRequest(
  file: File | null,
  userId?: string | null,
  authToken?: string,
): NextRequest {
  const formData = new FormData();
  if (file) {
    formData.append("file", file);
  }

  const headers: Record<string, string> = {};
  // Clerk mock handles auth — no explicit header needed when userId is set
  if (userId === null) {
    // explicitly unauthenticated
    headers["x-no-auth"] = "true";
  }
  if (authToken) {
    headers["authorization"] = `Bearer ${authToken}`;
  }

  return new NextRequest("http://localhost:3000/api/zero/uploads", {
    method: "POST",
    body: formData,
    headers,
  });
}

describe("POST /api/zero/uploads", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  describe("Authentication", () => {
    it("should reject unauthenticated requests", async () => {
      mockClerk({ userId: null });

      const file = new File(["hello"], "test.txt", { type: "text/plain" });
      const request = createUploadRequest(file, null);

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should accept ZERO_TOKEN with file:write capability", async () => {
      mockClerk({ userId: null });
      const token = await generateZeroToken(user.userId, "run-1", user.orgId);

      const file = new File(["hello"], "hello.txt", { type: "text/plain" });
      const request = createUploadRequest(file, undefined, token);

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.filename).toBe("hello.txt");
    });

    it("should reject sandbox token without file:write capability", async () => {
      mockClerk({ userId: null });
      const token = await generateSandboxToken(user.userId, "run-1");

      const file = new File(["hello"], "hello.txt", { type: "text/plain" });
      const request = createUploadRequest(file, undefined, token);

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("Validation", () => {
    it("should reject request without file", async () => {
      const request = createUploadRequest(null);

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
      expect(data.error.message).toContain("No file");
    });

    it("should reject file exceeding 10 MB", async () => {
      // Create a file slightly over 10 MB
      const largeBuffer = new ArrayBuffer(10 * 1024 * 1024 + 1);
      const file = new File([largeBuffer], "large.txt", {
        type: "text/plain",
      });
      const request = createUploadRequest(file);

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("File too large");
    });

    it("should reject unsupported file types", async () => {
      const file = new File(["data"], "script.exe", {
        type: "application/x-msdownload",
      });
      const request = createUploadRequest(file);

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.message).toContain("Unsupported file type");
    });
  });

  describe("Success", () => {
    it("should upload a valid text file and return metadata", async () => {
      const content = "Hello, world!";
      const file = new File([content], "hello.txt", { type: "text/plain" });
      const request = createUploadRequest(file);

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.id).toBeDefined();
      expect(data.filename).toBe("hello.txt");
      expect(data.contentType).toBe("text/plain");
      expect(data.size).toBe(content.length);
      expect(data.url).toBe("https://mock-presigned-url");

      // Verify S3 was called
      expect(context.mocks.s3.uploadS3Buffer).toHaveBeenCalledOnce();
      expect(context.mocks.s3.generatePresignedUrl).toHaveBeenCalledOnce();
    });

    it("should upload a valid image file", async () => {
      const file = new File([new ArrayBuffer(100)], "photo.png", {
        type: "image/png",
      });
      const request = createUploadRequest(file);

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.filename).toBe("photo.png");
      expect(data.contentType).toBe("image/png");
    });

    it("should upload a valid video file", async () => {
      const file = new File([new ArrayBuffer(100)], "clip.mp4", {
        type: "video/mp4",
      });
      const request = createUploadRequest(file);

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.filename).toBe("clip.mp4");
      expect(data.contentType).toBe("video/mp4");
    });

    it("should upload a valid PDF file", async () => {
      const file = new File([new ArrayBuffer(50)], "document.pdf", {
        type: "application/pdf",
      });
      const request = createUploadRequest(file);

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.contentType).toBe("application/pdf");
    });

    it("should sanitize filenames with special characters", async () => {
      const file = new File(["data"], "my file (1).txt", {
        type: "text/plain",
      });
      const request = createUploadRequest(file);

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify the S3 key uses sanitized name
      const uploadCall = context.mocks.s3.uploadS3Buffer.mock.calls[0];
      const s3Key = uploadCall?.[1] as string;
      expect(s3Key).toContain("my_file__1_.txt");
      expect(s3Key).toContain(`uploads/${user.userId}/`);
    });
  });
});
