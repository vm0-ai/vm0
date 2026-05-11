import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function validBody() {
  return { filename: "hello.txt", contentType: "text/plain", size: 13 };
}

describe("POST /api/zero/uploads/prepare", () => {
  const track = createFixtureTracker<OrgMembershipFixture>((fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroUploadsContract);
    const response = await accept(
      client.prepare({ body: validBody(), headers: {} }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("accepts ZERO_TOKEN with file:write capability and returns presigned URL", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    await track(
      store.set(seedOrgMembership$, { orgId, userId }, context.signal),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId,
      capabilities: ["file:write"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await client.prepare({
      body: validBody(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(response.body.url).toMatch(/^https?:\/\//);
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects invalid body shape with 400", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await accept(
      client.prepare({
        body: { filename: "" } as never,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects files larger than 1 GB with 400", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await accept(
      client.prepare({
        body: {
          filename: "big.bin",
          contentType: "application/pdf",
          size: 1024 * 1024 * 1024 + 1,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("File too large");
  });

  it("rejects unsupported content types with 400", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await accept(
      client.prepare({
        body: {
          filename: "bad.exe",
          contentType: "application/x-msdownload",
          size: 10,
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("Unsupported file type");
  });

  it("returns presigned upload URL and final GET URL with full body shape", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await client.prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);
    if (response.status !== 200) {
      return;
    }
    expect(response.body).toMatchObject({
      filename: "hello.txt",
      contentType: "text/plain",
      size: 13,
    });
    expect(response.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(response.body.url).toMatch(/^https?:\/\//);
    expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses the public S3 endpoint for externally consumed upload URLs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    mockEnv("S3_ENDPOINT", "http://internal-s3.example.com");
    mockEnv("S3_PUBLIC_ENDPOINT", "http://public-s3.example.com");

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await client.prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(200);

    const config = context.mocks.s3.clientConfig.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      endpoint: "http://public-s3.example.com",
      region: "auto",
      forcePathStyle: false,
    });
  });

  it("sanitizes filenames in the S3 key", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroUploadsContract);
    await client.prepare({
      body: {
        filename: "my file (1).txt",
        contentType: "text/plain",
        size: 10,
      },
      headers: { authorization: "Bearer clerk-session" },
    });

    const calls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const command = calls[0]?.[1] as { input: { Key: string } };
    expect(command.input.Key).toContain("my_file__1_.txt");
    expect(command.input.Key).toContain(`uploads/${userId}/`);
  });

  it("accepts representative MIME types from the allowlist", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const cases = [
      { filename: "screenshot.avif", contentType: "image/avif" },
      { filename: "report.html", contentType: "text/html" },
      { filename: "clip.mp3", contentType: "audio/mpeg" },
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
      { filename: "doc.pdf", contentType: "application/pdf" },
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

    const client = setupApp({ context })(zeroUploadsContract);
    for (const { filename, contentType } of cases) {
      const response = await client.prepare({
        body: { filename, contentType, size: 4096 },
        headers: { authorization: "Bearer clerk-session" },
      });
      expect(response.status).toBe(200);
      if (response.status !== 200) {
        continue;
      }
      expect(response.body).toMatchObject({ filename, contentType });
    }
  });

  it("returns 403 for sandbox token without file:write capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId,
      orgId,
      runId,
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroUploadsContract);
    const response = await accept(
      client.prepare({
        body: validBody(),
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("file:write");
  });
});
