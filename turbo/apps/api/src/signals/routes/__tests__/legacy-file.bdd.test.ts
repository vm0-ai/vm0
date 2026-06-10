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

function mockS3ArtifactExists(): void {
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://signed.example.com/doc.pdf?sig=abc",
  );
}

describe("GET /f/:userId/:id/:filename BDD", () => {
  beforeEach(() => {
    mockS3ArtifactExists();
  });

  it("redirects migrated and fallback legacy file links with CORS handling", async () => {
    const migrated = await appRequest("/f/user_alice/file-id/doc.pdf");

    expect(migrated.status).toBe(302);
    expect(migrated.headers.get("Location")).toBe(
      "https://cdn.vm7.io/artifacts/user_alice/file-id/doc.pdf",
    );
    expect(migrated.headers.get("Cache-Control")).toContain("public");
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user_alice/file-id/doc.pdf",
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();

    context.mocks.s3.send.mockClear();
    const prefixless = await appRequest("/f/alice/file-id/doc.pdf");

    expect(prefixless.status).toBe(302);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user_alice/file-id/doc.pdf",
    });

    context.mocks.s3.send.mockClear();
    const nonClerk = await appRequest("/f/user-1/file-id/doc.pdf");

    expect(nonClerk.status).toBe(302);
    expect(
      commandInput(context.mocks.s3.send.mock.calls[0]?.[0]),
    ).toMatchObject({
      Bucket: "test-user-artifacts",
      Key: "artifacts/user-1/file-id/doc.pdf",
    });

    context.mocks.s3.send.mockRejectedValueOnce({
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
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

    const corsRedirect = await appRequest("/f/user_alice/file-id/notes.md", {
      headers: { origin: "https://app.vm7.ai:8443" },
    });

    expect(corsRedirect.status).toBe(302);
    expect(corsRedirect.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm7.ai:8443",
    );
    expect(corsRedirect.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );

    const preflight = await appRequest("/f/user_alice/file-id/notes.md", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.vm7.ai:8443",
        "Access-Control-Request-Method": "GET",
      },
    });

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
