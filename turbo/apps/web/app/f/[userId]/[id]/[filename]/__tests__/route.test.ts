import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, OPTIONS } from "../route";
import { reloadEnv } from "../../../../../../src/env";
import * as s3Client from "../../../../../../src/lib/infra/s3/s3-client";

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function mockS3() {
  return {
    generatePresignedUrl: vi
      .spyOn(s3Client, "generatePresignedUrl")
      .mockResolvedValue("https://mock-presigned-url"),
    s3ObjectExists: vi
      .spyOn(s3Client, "s3ObjectExists")
      .mockResolvedValue(true),
  };
}

let s3Mocks: ReturnType<typeof mockS3>;

async function invoke(
  userId: string,
  id: string,
  filename: string,
  searchParams = "",
  init?: NextRequestInit,
) {
  const url = `http://localhost:3000/f/${userId}/${id}/${filename}${searchParams}`;
  return GET(new NextRequest(url, init), {
    params: Promise.resolve({ userId, id, filename }),
  });
}

describe("GET /f/[userId]/[id]/[filename]", () => {
  beforeEach(() => {
    s3Mocks = mockS3();
  });

  it("302-redirects legacy /f links to the public artifact CDN when the migrated object exists", async () => {
    const res = await invoke("user_alice", "file-id", "doc.pdf");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://cdn.vm7.io/artifacts/user_alice/file-id/doc.pdf",
    );
    expect(res.headers.get("Cache-Control")).toContain("public");
    expect(s3Mocks.s3ObjectExists).toHaveBeenCalledWith(
      "test-artifacts-bucket",
      "artifacts/user_alice/file-id/doc.pdf",
    );
    expect(s3Mocks.generatePresignedUrl).not.toHaveBeenCalled();
  });

  it("maps prefixless public user IDs back to Clerk user IDs", async () => {
    const res = await invoke("alice", "file-id", "doc.pdf");

    expect(res.status).toBe(302);

    expect(s3Mocks.s3ObjectExists).toHaveBeenCalledWith(
      "test-artifacts-bucket",
      "artifacts/user_alice/file-id/doc.pdf",
    );
  });

  it("keeps non-Clerk user-like URL segments unchanged", async () => {
    await invoke("user-1", "file-id", "doc.pdf");

    expect(s3Mocks.s3ObjectExists).toHaveBeenCalledWith(
      "test-artifacts-bucket",
      "artifacts/user-1/file-id/doc.pdf",
    );
  });

  it("falls back to old user-storage presigned URLs when the artifact object is absent", async () => {
    s3Mocks.s3ObjectExists.mockResolvedValueOnce(false);
    s3Mocks.generatePresignedUrl.mockResolvedValue(
      "https://signed.example.com/doc.pdf?sig=abc",
    );

    const res = await invoke("user_alice", "file-id", "doc.pdf");

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://signed.example.com/doc.pdf?sig=abc",
    );
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(s3Mocks.generatePresignedUrl).toHaveBeenCalledWith(
      "test-bucket",
      "uploads/user_alice/file-id/doc.pdf",
      300,
      undefined,
      true,
    );
  });

  it("adds cors headers for allowed origins on redirects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    reloadEnv();

    const res = await invoke("user_alice", "file-id", "notes.md", "", {
      headers: { origin: "https://app.vm7.ai:8443" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("handles cors preflight for allowed origins", async () => {
    vi.stubEnv("NODE_ENV", "development");
    reloadEnv();
    const req = new NextRequest(
      "http://localhost:3000/f/user_alice/file-id/notes.md",
      {
        method: "OPTIONS",
        headers: { origin: "https://app.vm7.ai:8443" },
      },
    );

    const res = OPTIONS(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain(
      "OPTIONS",
    );
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Range");
  });
});
