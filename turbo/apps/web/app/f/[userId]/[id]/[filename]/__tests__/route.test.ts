import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, OPTIONS } from "../route";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";

const context = testContext();
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

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

  it("proxies file contents when ?raw=1 is present", async () => {
    context.mocks.s3.generatePresignedUrl.mockResolvedValue(
      "https://signed.example.com/notes.md",
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("# Raw markdown", {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      }),
    );

    const res = await invoke("user_alice", "file-id", "notes.md", "?raw=1");

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("# Raw markdown");
    expect(res.headers.get("Content-Type")).toContain("text/markdown");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://signed.example.com/notes.md",
    );
    fetchSpy.mockRestore();
  });

  it("adds cors headers for allowed origins on raw responses", async () => {
    vi.stubEnv("NODE_ENV", "development");
    reloadEnv();
    context.mocks.s3.generatePresignedUrl.mockResolvedValue(
      "https://signed.example.com/notes.md",
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("plain text", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );

    const res = await invoke("user_alice", "file-id", "notes.md", "?raw=1", {
      headers: { origin: "https://app.vm7.ai:8443" },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    fetchSpy.mockRestore();
  });

  it("handles cors preflight for allowed origins", async () => {
    vi.stubEnv("NODE_ENV", "development");
    reloadEnv();
    const req = new NextRequest(
      "http://localhost:3000/f/user_alice/file-id/notes.md?raw=1",
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
  });
});
