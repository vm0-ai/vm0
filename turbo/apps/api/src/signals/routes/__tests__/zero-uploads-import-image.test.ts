import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const REMOTE_IMAGE_URL = "https://images.example.test/gallery/strawberry.png";
const REDIRECT_IMAGE_URL = "https://images.example.test/gallery/redirect";
const REMOTE_HTML_URL = "https://images.example.test/gallery/not-image";
const IMAGE_BYTES = Buffer.from("remote image bytes");

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function client() {
  return setupApp({ context })(zeroUploadsContract);
}

describe("POST /api/zero/uploads/import-image", () => {
  beforeEach(() => {
    context.mocks.nodeRequest.pinnedAddresses.length = 0;
    // Resolve the fake MSW host to a public address so the SSRF guard's DNS
    // lookup does not hit the real resolver (which would fail on .test).
    context.mocks.dns.lookupOverrides.set("images.example.test", [
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it("imports a remote image into user artifact storage", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const putObjectInputs: Record<string, unknown>[] = [];

    mocks.clerk.session(userId, null);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (commandName(command) === "PutObjectCommand") {
        putObjectInputs.push(commandInput(command));
      }
      return Promise.resolve({});
    });
    server.use(
      http.get(REMOTE_IMAGE_URL, () => {
        return new HttpResponse(new Uint8Array(IMAGE_BYTES), {
          headers: {
            "content-length": String(IMAGE_BYTES.byteLength),
            "content-type": "image/png",
          },
        });
      }),
    );

    const response = await accept(
      client().importImage({
        headers: authHeaders(),
        body: { url: REMOTE_IMAGE_URL },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "strawberry.png",
      contentType: "image/png",
      size: IMAGE_BYTES.byteLength,
    });
    expect(response.body.url).toContain(
      `/artifacts/${encodeURIComponent(userId)}/`,
    );
    expect(response.body.url).toMatch(/\/strawberry\.png$/);
    const putObjectInput = putObjectInputs[0];
    if (!putObjectInput) {
      throw new Error("Expected imported image to be uploaded");
    }
    expect(putObjectInput).toMatchObject({
      Bucket: "test-user-artifacts",
      ContentType: "image/png",
    });
    expect(String(putObjectInput?.Key)).toContain(
      `artifacts/${encodeURIComponent(userId)}/`,
    );
    const body = putObjectInput?.Body;
    if (!Buffer.isBuffer(body)) {
      throw new Error("Expected imported image bytes to be uploaded");
    }
    expect(body).toStrictEqual(IMAGE_BYTES);
  });

  it("rejects remote URLs that do not return images", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, null);
    server.use(
      http.get(REMOTE_HTML_URL, () => {
        return new HttpResponse("<html></html>", {
          headers: { "content-type": "text/html" },
        });
      }),
    );

    const response = await accept(
      client().importImage({
        headers: authHeaders(),
        body: { url: REMOTE_HTML_URL },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "must point to a PNG, JPEG, GIF, WebP, AVIF, or BMP image",
    );
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("rejects redirected remote image URLs without following them", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    let redirectTargetFetches = 0;

    mocks.clerk.session(userId, null);
    server.use(
      http.get(REDIRECT_IMAGE_URL, () => {
        return new HttpResponse(null, {
          headers: { location: REMOTE_IMAGE_URL },
          status: 302,
        });
      }),
      http.get(REMOTE_IMAGE_URL, () => {
        redirectTargetFetches += 1;
        return new HttpResponse(new Uint8Array(IMAGE_BYTES), {
          headers: {
            "content-length": String(IMAGE_BYTES.byteLength),
            "content-type": "image/png",
          },
        });
      }),
    );

    const response = await accept(
      client().importImage({
        headers: authHeaders(),
        body: { url: REDIRECT_IMAGE_URL },
      }),
      [502],
    );

    expect(response.body.error).toMatchObject({
      code: "IMAGE_IMPORT_FETCH_FAILED",
      message: "Couldn't fetch image URL",
    });
    expect(redirectTargetFetches).toBe(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("rejects hosts that resolve to a private address", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    let fetches = 0;
    mocks.clerk.session(userId, null);
    context.mocks.dns.lookupOverrides.set("blocked-host.example.test", [
      { address: "169.254.169.254", family: 4 },
    ]);
    server.use(
      http.get("https://blocked-host.example.test/photo.png", () => {
        fetches += 1;
        return new HttpResponse(new Uint8Array(IMAGE_BYTES), {
          headers: { "content-type": "image/png" },
        });
      }),
    );

    const response = await accept(
      client().importImage({
        headers: authHeaders(),
        body: { url: "https://blocked-host.example.test/photo.png" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("host is not allowed");
    expect(fetches).toBe(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("pins the vetted DNS address for the image fetch", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    let lookupCount = 0;

    mocks.clerk.session(userId, null);
    context.mocks.dns.lookupOverrides.set("rebind-host.example.test", () => {
      lookupCount += 1;
      return lookupCount === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }];
    });
    server.use(
      http.get("https://rebind-host.example.test/photo.png", () => {
        return new HttpResponse(new Uint8Array(IMAGE_BYTES), {
          headers: { "content-type": "image/png" },
        });
      }),
    );

    const response = await accept(
      client().importImage({
        headers: authHeaders(),
        body: { url: "https://rebind-host.example.test/photo.png" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      filename: "photo.png",
      contentType: "image/png",
      size: IMAGE_BYTES.byteLength,
    });
    expect(lookupCount).toBe(1);
    expect(context.mocks.nodeRequest.pinnedAddresses).toStrictEqual([
      "93.184.216.34",
    ]);
  });

  it("rejects private IP literal hosts", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, null);

    const response = await accept(
      client().importImage({
        headers: authHeaders(),
        body: { url: "http://169.254.169.254/latest/meta-data" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("host is not allowed");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });
});
