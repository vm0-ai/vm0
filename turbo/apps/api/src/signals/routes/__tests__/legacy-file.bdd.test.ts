import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (!isRecord(command) || !("input" in command)) {
    throw new Error("Expected AWS command with input");
  }
  const candidate = command.input;
  if (!isRecord(candidate)) {
    throw new Error("Expected AWS command input object");
  }
  return candidate;
}

function optionsInput(options: unknown): Record<string, unknown> {
  if (!isRecord(options)) {
    throw new Error("Expected presign options object");
  }
  return options;
}

const context = testContext();

function appRequest(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(
    createApp({ signal: context.signal }).request(path, {
      method: "GET",
      ...init,
    }),
  );
}

describe("BDD GET /f/:userId/:id/:filename — 302 happy-path chain", () => {
  beforeEach(() => {
    context.mocks.s3.send.mockClear();
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.s3.getSignedUrl.mockClear();
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://signed.example.com/doc.pdf?sig=abc",
    );
  });

  it("gwt-wt-wt: 302 redirects to public CDN for migrated object → 302 maps prefixless user IDs to Clerk IDs → 302 keeps non-Clerk URL segments unchanged → 302 falls back to presigned URL when artifact object is absent → 302 adds CORS headers for allowed origins → 204 handles CORS preflight for allowed origins", async () => {
    // When + Then: 302 — Clerk-style user id, migrated object
    // exists → redirects to the public artifact CDN.
    const clerkStyle = await appRequest("/f/user_alice/file-id/doc.pdf");
    expect(clerkStyle.status).toBe(302);
    expect(clerkStyle.headers.get("Location")).toBe(
      "https://cdn.vm7.io/artifacts/user_alice/file-id/doc.pdf",
    );
    expect(clerkStyle.headers.get("Cache-Control")).toContain("public");
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user_alice/file-id/doc.pdf",
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();

    // When + Then: 302 — prefixless public user id is mapped
    // back to a Clerk user id.
    const prefixless = await appRequest("/f/alice/file-id/doc.pdf");
    expect(prefixless.status).toBe(302);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[1]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user_alice/file-id/doc.pdf",
    });

    // When + Then: 302 — non-Clerk user-like URL segment is
    // preserved as-is.
    const nonClerk = await appRequest("/f/user-1/file-id/doc.pdf");
    expect(nonClerk.status).toBe(302);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[2]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user-1/file-id/doc.pdf",
    });

    // Given: the migrated object is absent.
    context.mocks.s3.send.mockRejectedValueOnce({
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });

    // When + Then: 302 — falls back to a presigned URL on
    // the old user-storage bucket with private cache control.
    const fallback = await appRequest("/f/user_alice/file-id/doc.pdf");
    expect(fallback.status).toBe(302);
    expect(fallback.headers.get("Location")).toBe(
      "https://signed.example.com/doc.pdf?sig=abc",
    );
    expect(fallback.headers.get("Cache-Control")).toContain("private");
    const [, command, options] =
      context.mocks.s3.getSignedUrl.mock.calls[0] ?? [];
    expect(commandInput(command)).toMatchObject({
      Bucket: "test-user-storages",
      Key: "uploads/user_alice/file-id/doc.pdf",
    });
    expect(optionsInput(options)).toMatchObject({ expiresIn: 300 });

    // When + Then: 302 — allowed origin on the redirect
    // response gets CORS headers.
    const corsRedirect = await appRequest(
      "/f/user_alice/file-id/notes.md",
      { headers: { origin: "https://app.vm7.ai:8443" } },
    );
    expect(corsRedirect.status).toBe(302);
    expect(corsRedirect.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(corsRedirect.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );

    // When + Then: 204 — CORS preflight for the same
    // allowed origin.
    const preflight = await appRequest(
      "/f/user_alice/file-id/notes.md",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://app.vm7.ai:8443",
          "Access-Control-Request-Method": "GET",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
      "GET",
    );
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
      "OPTIONS",
    );
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
      "Range",
    );
  });
});
