import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { orgMetadata } from "@vm0/db/schema/org-metadata";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";

// BDD migration of the legacy
// `zero-uploads-prepare.test.ts`. The 13 legacy `it()`s
// collapse into 3 BDD `it()`s: (1) auth + bad-body chain
// (401 unauthenticated → 400 invalid body shape → 400 file
// too large → 400 unsupported content type → 403 sandbox
// token without `file:write`), (2) success + body shape
// chain (200 ZERO_TOKEN with `file:write` returns presigned
// URL + 200 full body shape with filename + contentType +
// size + cdn URL → 402 suspended org with insufficient
// credits → 200 normalizes parameterized content types
// before signing → 200 uses public S3 endpoint for
// externally consumed upload URLs → 200 sanitizes filenames
// in the S3 key), (3) MIME allowlist chain (200 accepts
// representative MIME types from the allowlist).
//
// Service-Level Exception: `orgMetadata` rows are seeded
// directly via `writeDb$` to control the org tier for
// credits and S3 endpoint tests.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function validBody() {
  return { filename: "hello.txt", contentType: "text/plain", size: 13 };
}

async function seedOrgTier(
  orgId: string,
  tier: "free" | "pro-suspend",
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(orgMetadata)
    .values({ orgId, tier, credits: 10_000 })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { tier, credits: 10_000 },
    });
}

function createUploadsHarness(): {
  readonly track: ReturnType<typeof createFixtureTracker<OrgMembershipFixture>>;
} {
  const track = createFixtureTracker<OrgMembershipFixture>(async (fixture) => {
    await store
      .set(writeDb$)
      .delete(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    await store.set(deleteOrgMembership$, fixture, context.signal);
  });
  return { track };
}

describe("BDD POST /api/zero/uploads/prepare — auth + bad-body chain", () => {
  const { track } = createUploadsHarness();

  it("gwt-wt-wt: 401 unauthenticated → 400 invalid body shape → 400 file too large → 400 unsupported content type → 403 sandbox token without `file:write`", async () => {
    // Given: no auth header.
    const client = setupApp({ context })(zeroUploadsContract);

    // When + Then: 401.
    const noAuth = await accept(
      client.prepare({ body: validBody(), headers: {} }),
      [401],
    );
    expect(noAuth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: a Clerk session.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    // When + Then: 400 — invalid body shape.
    const invalidBody = await accept(
      client.prepare({
        body: { filename: "" } as never,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");

    // When + Then: 400 — file too large.
    const tooLarge = await accept(
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
    expect(tooLarge.body.error.message).toContain("File too large");

    // When + Then: 400 — unsupported content type.
    const unsupported = await accept(
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
    expect(unsupported.body.error.message).toContain("Unsupported file type");

    // Given: a sandbox token without `file:write`.
    const sandboxUserId = `user_${randomUUID()}`;
    const sandboxOrgId = `org_${randomUUID()}`;
    const sandboxRunId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: sandboxUserId,
      orgId: sandboxOrgId,
      runId: sandboxRunId,
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: 403 — sandbox without `file:write`.
    const sandbox = await accept(
      client.prepare({
        body: validBody(),
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
    expect(sandbox.body.error.code).toBe("FORBIDDEN");
    expect(sandbox.body.error.message).toContain("file:write");
  });
});

describe("BDD POST /api/zero/uploads/prepare — success + body shape chain", () => {
  const { track } = createUploadsHarness();

  it("gwt-wt-wt: 200 ZERO_TOKEN with `file:write` returns presigned URL + 200 full body shape with filename + contentType + size + cdn URL → 402 suspended org with insufficient credits → 200 normalizes parameterized content types before signing → 200 uses public S3 endpoint for externally consumed upload URLs → 200 sanitizes filenames in the S3 key", async () => {
    // Given: a ZERO_TOKEN with `file:write` for an org.
    const zeroUserId = `user_${randomUUID().slice(0, 8)}`;
    const zeroOrgId = `org_${randomUUID().slice(0, 8)}`;
    const zeroRunId = `run_${randomUUID()}`;
    await track(
      store.set(
        seedOrgMembership$,
        { orgId: zeroOrgId, userId: zeroUserId },
        context.signal,
      ),
    );
    await seedOrgTier(zeroOrgId, "free");
    const seconds = currentSecond();
    const zeroTokenStr = signSandboxJwtForTests({
      scope: "zero",
      userId: zeroUserId,
      orgId: zeroOrgId,
      runId: zeroRunId,
      capabilities: ["file:write"],
      iat: seconds,
      exp: seconds + 60,
    });

    const client = setupApp({ context })(zeroUploadsContract);

    // When + Then: 200 — presigned URL + id are
    // returned.
    const zeroResponse = await client.prepare({
      body: validBody(),
      headers: { authorization: `Bearer ${zeroTokenStr}` },
    });
    expect(zeroResponse.status).toBe(200);
    if (zeroResponse.status === 200) {
      expect(zeroResponse.body.uploadUrl).toMatch(/^https?:\/\//);
      expect(zeroResponse.body.url).toMatch(/^https?:\/\//);
      expect(zeroResponse.body.id).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Given: a Clerk session for a `free` org.
    const sessionUserId = `user_${randomUUID()}`;
    const sessionOrgId = `org_${randomUUID()}`;
    await seedOrgTier(sessionOrgId, "free");
    mocks.clerk.session(sessionUserId, sessionOrgId);
    context.mocks.s3.getSignedUrl.mockClear();
    context.mocks.s3.clientConfig.mockClear();

    // When + Then: 200 — full body shape matches the
    // request + the CDN URL is composed from userId +
    // upload id + filename.
    const sessionResponse = await client.prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(sessionResponse.status).toBe(200);
    if (sessionResponse.status === 200) {
      expect(sessionResponse.body).toMatchObject({
        filename: "hello.txt",
        contentType: "text/plain",
        size: 13,
      });
      expect(sessionResponse.body.uploadUrl).toMatch(/^https?:\/\//);
      expect(sessionResponse.body.url).toBe(
        `https://cdn.vm7.io/artifacts/${sessionUserId}/${sessionResponse.body.id}/hello.txt`,
      );
      expect(sessionResponse.body.id).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Given: a Clerk session for a `pro-suspend` org.
    const suspendedUserId = `user_${randomUUID()}`;
    const suspendedOrgId = `org_${randomUUID()}`;
    await seedOrgTier(suspendedOrgId, "pro-suspend");
    mocks.clerk.session(suspendedUserId, suspendedOrgId);

    // When + Then: 402 — insufficient credits.
    const suspendedResponse = await accept(
      client.prepare({
        body: validBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [402],
    );
    expect(suspendedResponse.body.error.code).toBe("INSUFFICIENT_CREDITS");

    // Given: a Clerk session + a parameterized content
    // type.
    const normalizedUserId = `user_${randomUUID()}`;
    const normalizedOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(normalizedUserId, normalizedOrgId);
    context.mocks.s3.getSignedUrl.mockClear();

    // When + Then: 200 — content type is normalized
    // before signing.
    const normalizedResponse = await client.prepare({
      body: {
        filename: "notes.txt",
        contentType: "Text/Plain; Charset=UTF-8",
        size: 13,
      },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(normalizedResponse.status).toBe(200);
    if (normalizedResponse.status === 200) {
      expect(normalizedResponse.body.contentType).toBe("text/plain");
    }
    const normalizedCommand = context.mocks.s3.getSignedUrl.mock
      .calls[0]?.[1] as { input: { ContentType: string } };
    expect(normalizedCommand.input.ContentType).toBe("text/plain");

    // Given: a Clerk session + the S3 endpoint env is
    // set to internal + the S3_PUBLIC_ENDPOINT is set.
    const publicUserId = `user_${randomUUID()}`;
    const publicOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(publicUserId, publicOrgId);
    mockEnv("S3_ENDPOINT", "http://internal-s3.example.com");
    mockEnv("S3_PUBLIC_ENDPOINT", "http://public-s3.example.com");
    context.mocks.s3.clientConfig.mockClear();

    // When + Then: 200 — the upload URLs use the public
    // S3 endpoint.
    const publicResponse = await client.prepare({
      body: validBody(),
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(publicResponse.status).toBe(200);
    const publicConfig = context.mocks.s3.clientConfig.mock.calls[0]?.[0];
    expect(publicConfig).toMatchObject({
      endpoint: "http://public-s3.example.com",
      credentials: {
        accessKeyId: "test-artifacts-access-key",
        secretAccessKey: "test-artifacts-secret-key",
      },
      region: "auto",
      forcePathStyle: false,
    });

    // Given: a Clerk session + a filename with spaces +
    // parens.
    const sanitizedUserId = `user_${randomUUID()}`;
    const sanitizedOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(sanitizedUserId, sanitizedOrgId);
    context.mocks.s3.getSignedUrl.mockClear();

    // When + Then: 200 — the S3 key sanitizes the
    // filename.
    await client.prepare({
      body: {
        filename: "my file (1).txt",
        contentType: "text/plain",
        size: 10,
      },
      headers: { authorization: "Bearer clerk-session" },
    });
    const sanitizedCalls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(sanitizedCalls.length).toBeGreaterThan(0);
    const sanitizedCommand = sanitizedCalls[0]?.[1] as {
      input: { Bucket: string; Key: string };
    };
    expect(sanitizedCommand.input.Bucket).toBe("test-user-artifacts");
    expect(sanitizedCommand.input.Key).toContain("my_file__1_.txt");
    expect(sanitizedCommand.input.Key).toContain(
      `artifacts/${sanitizedUserId}/`,
    );
  });
});

describe("BDD POST /api/zero/uploads/prepare — MIME allowlist chain", () => {
  it("gwt-wt-wt: 200 accepts representative MIME types from the allowlist", async () => {
    // Given: a Clerk session + a list of representative
    // MIME types from the allowlist.
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
      {
        filename: "design.psd",
        contentType: "image/vnd.adobe.photoshop",
      },
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
      {
        filename: "local.sqlite",
        contentType: "application/vnd.sqlite3",
      },
      { filename: "book.epub", contentType: "application/epub+zip" },
    ] as const;

    const client = setupApp({ context })(zeroUploadsContract);

    // When + Then: 200 for every allowlisted MIME type
    // with the expected filename + contentType in the
    // response.
    for (const { filename, contentType } of cases) {
      const response = await client.prepare({
        body: { filename, contentType, size: 4096 },
        headers: { authorization: "Bearer clerk-session" },
      });
      expect(response.status).toBe(200);
      if (response.status === 200) {
        expect(response.body).toMatchObject({ filename, contentType });
      }
    }
  });
});
