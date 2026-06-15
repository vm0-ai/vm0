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

describe("GET /f/:userId/:id/:filename", () => {
  beforeEach(() => {
    context.mocks.s3.send.mockResolvedValue({});
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://signed.example.com/doc.pdf?sig=abc",
    );
  });

  it("302-redirects legacy file links to the public artifact CDN when the migrated object exists", async () => {
    const response = await appRequest("/f/user_alice/file-id/doc.pdf");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://cdn.vm7.io/artifacts/user_alice/file-id/doc.pdf",
    );
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user_alice/file-id/doc.pdf",
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("maps prefixless public user IDs back to Clerk user IDs", async () => {
    const response = await appRequest("/f/alice/file-id/doc.pdf");

    expect(response.status).toBe(302);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user_alice/file-id/doc.pdf",
    });
  });

  it("keeps non-Clerk user-like URL segments unchanged", async () => {
    const response = await appRequest("/f/user-1/file-id/doc.pdf");

    expect(response.status).toBe(302);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user-1/file-id/doc.pdf",
    });
  });

  it("falls back to old user-storage presigned URLs when the artifact object is absent", async () => {
    context.mocks.s3.send.mockRejectedValueOnce({
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });

    const response = await appRequest("/f/user_alice/file-id/doc.pdf");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://signed.example.com/doc.pdf?sig=abc",
    );
    expect(response.headers.get("Cache-Control")).toContain("private");
    const [, command, options] =
      context.mocks.s3.getSignedUrl.mock.calls[0] ?? [];
    expect(commandInput(command)).toMatchObject({
      Bucket: "test-user-storages",
      Key: "uploads/user_alice/file-id/doc.pdf",
    });
    expect(optionsInput(options)).toMatchObject({ expiresIn: 300 });
  });

  it("adds CORS headers for allowed origins on redirects", async () => {
    const response = await appRequest("/f/user_alice/file-id/notes.md", {
      headers: { origin: "https://app.vm7.ai:8443" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
  });

  it("handles CORS preflight for allowed origins", async () => {
    const response = await appRequest("/f/user_alice/file-id/notes.md", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.vm7.ai:8443",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "GET",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Range",
    );
  });
});
