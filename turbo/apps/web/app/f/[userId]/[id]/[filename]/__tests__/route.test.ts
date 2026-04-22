import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";
import { testContext } from "../../../../../../src/__tests__/test-helpers";

const context = testContext();

async function invoke(
  userId: string,
  id: string,
  filename: string,
  searchParams = "",
) {
  const url = `http://localhost:3000/f/${userId}/${id}/${filename}${searchParams}`;
  return GET(new NextRequest(url), {
    params: Promise.resolve({ userId, id, filename }),
  });
}

describe("GET /f/[userId]/[id]/[filename]", () => {
  beforeEach(async () => {
    context.setupMocks();
  });

  it("302-redirects to a short-lived presigned URL built from the S3 key convention", async () => {
    context.mocks.s3.generatePresignedUrl.mockResolvedValue(
      "https://signed.example.com/doc.pdf?sig=abc",
    );

    const res = await invoke("user_alice", "file-id", "doc.pdf");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://signed.example.com/doc.pdf?sig=abc",
    );
    expect(res.headers.get("Cache-Control")).toContain("private");

    const [, key, ttlSeconds, contentDisposition] =
      context.mocks.s3.generatePresignedUrl.mock.calls[0] ?? [];
    // The key must be derived from the path segments, so any URL the user can
    // hold (past or future) resolves to the correct R2 object without lookup.
    expect(key).toBe("uploads/user_alice/file-id/doc.pdf");
    // Short TTL keeps stale redirects from outliving the browser cache window.
    expect(ttlSeconds).toBe(300);
    expect(contentDisposition).toBeUndefined();
  });

  it("forces attachment download when ?download=1 is present", async () => {
    context.mocks.s3.generatePresignedUrl.mockResolvedValue(
      "https://signed.example.com/report.pdf",
    );

    await invoke("user_alice", "file-id", "report.pdf", "?download=1");

    const call = context.mocks.s3.generatePresignedUrl.mock.calls[0];
    expect(call?.[3]).toBe("report.pdf");
  });
});
