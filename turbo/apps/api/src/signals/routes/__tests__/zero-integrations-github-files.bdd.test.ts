import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
} from "@vm0/api-contracts/contracts/integrations";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
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
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

// BDD migration of the legacy
// `zero-integrations-github-files.test.ts`. The 5 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) download chain
// (200 streams a GitHub context file from an allowed URL →
// 200 uses the GitHub URL filename when no hint → 400
// rejects non-GitHub file URLs → 403 requires `github:read`
// capability), (2) upload-init chain (200 returns a
// presigned upload URL with public S3 endpoint, body shape
// + sanitized filename + S3 key), (3) upload-complete
// chain (200 posts the URL to GitHub + records the run
// artifact with full metadata).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const GITHUB_APP_ID = "123456";

interface GitHubFileFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly remoteInstallationId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

function mockGitHubAppCredentials(): void {
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId?: string;
  readonly capabilities: readonly ("github:read" | "github:write")[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId ?? randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

function setupGitHubTokenMock(installationId: string): void {
  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      ({ request }) => {
        expect(request.headers.get("authorization")).toMatch(/^Bearer /u);
        return HttpResponse.json({
          token: "ghs_test_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

async function seedGithubInstallation(args: {
  readonly orgId: string;
  readonly composeId: string;
  readonly remoteInstallationId: string;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(githubInstallations).values({
    installationId: args.remoteInstallationId,
    status: "active",
    orgId: args.orgId,
    defaultComposeId: args.composeId,
  });
}

async function findUploadedFiles(args: {
  readonly runId: string;
  readonly externalId: string;
}) {
  const db = store.set(writeDb$);
  return await db
    .select()
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.runId, args.runId),
        eq(runUploadedFiles.externalId, args.externalId),
      ),
    );
}

const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});
const trackMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

async function seedFixture(): Promise<GitHubFileFixture> {
  const fixture = await trackUsage(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  await trackMembership(
    store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    ),
  );
  const compose = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const remoteInstallationId = String(
    Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000,
  );
  await seedGithubInstallation({
    orgId: fixture.orgId,
    composeId: compose.composeId,
    remoteInstallationId,
  });
  return {
    ...fixture,
    composeId: compose.composeId,
    remoteInstallationId,
  };
}

function downloadUrl(args: {
  readonly url: string;
  readonly filename?: string;
}): string {
  const params = new URLSearchParams({ url: args.url });
  if (args.filename) {
    params.set("filename", args.filename);
  }
  return `/api/zero/integrations/github/download-file?${params.toString()}`;
}

function downloadFileRequest(
  tokenUserId: string,
  tokenOrgId: string,
  capabilities: readonly ("github:read" | "github:write")[],
  url: string,
  filename?: string,
): Promise<Response> {
  // Reuse setupApp's contract client: the file routes are
  // mounted through app.request for streaming, so build a
  // plain RequestInit here.
  return import("../../../app-factory").then(({ createApp }) => {
    const app = createApp({ signal: context.signal });
    return app.request(downloadUrl({ url, filename }), {
      method: "GET",
      headers: {
        authorization: `Bearer ${zeroToken({
          userId: tokenUserId,
          orgId: tokenOrgId,
          capabilities,
        })}`,
      },
    });
  });
}

describe("BDD GitHub zero file integration routes — download chain", () => {
  it("gwt-wt-wt: 200 streams a GitHub context file from an allowed URL → 200 uses the GitHub URL filename when no hint → 400 rejects non-GitHub file URLs → 403 requires github:read capability", async () => {
    // Given: a fixture + a GitHub user-attachments URL
    // with a filename hint.
    const fixture = await seedFixture();
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    server.use(
      http.get(fileUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("accept")).toBe("application/octet-stream");
        return new HttpResponse("png-bytes", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "9",
          },
        });
      }),
    );

    // When + Then: 200 — the file is streamed with the
    // hint filename + content-type echoed as a header.
    const streamed = await downloadFileRequest(
      fixture.userId,
      fixture.orgId,
      ["github:read"],
      fileUrl,
      "screenshot.png",
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("image/png");
    expect(streamed.headers.get("x-file-name")).toBe("screenshot.png");
    expect(streamed.headers.get("x-file-mimetype")).toBe("image/png");
    await expect(streamed.text()).resolves.toBe("png-bytes");

    // Given: a fixture + a raw.githubusercontent.com URL
    // without a filename hint.
    const inferredFixture = await seedFixture();
    const inferredUrl =
      "https://raw.githubusercontent.com/vm0-ai/vm0/main/github-file.png";
    server.use(
      http.get(inferredUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("accept")).toBe("application/octet-stream");
        return new HttpResponse("artifact-bytes", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "14",
          },
        });
      }),
    );

    // When + Then: 200 — the GitHub URL filename is used
    // as the hint.
    const inferred = await downloadFileRequest(
      inferredFixture.userId,
      inferredFixture.orgId,
      ["github:read"],
      inferredUrl,
    );
    expect(inferred.status).toBe(200);
    expect(inferred.headers.get("content-type")).toBe("image/png");
    expect(inferred.headers.get("x-file-name")).toBe("github-file.png");
    await expect(inferred.text()).resolves.toBe("artifact-bytes");

    // Given: a fixture + a non-GitHub URL.

    // When + Then: 400 — non-GitHub URLs are rejected.
    const rejectedFixture = await seedFixture();
    const rejected = await downloadFileRequest(
      rejectedFixture.userId,
      rejectedFixture.orgId,
      ["github:read"],
      "https://example.com/file.png",
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    // Given: a fixture + a zero token with only
    // `github:write`.

    // When + Then: 403 — `github:read` capability is
    // required.
    const insufficientFixture = await seedFixture();
    const insufficient = await downloadFileRequest(
      insufficientFixture.userId,
      insufficientFixture.orgId,
      ["github:write"],
      fileUrl,
      "screenshot.png",
    );
    expect(insufficient.status).toBe(403);
    await expect(insufficient.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });
});

describe("BDD GitHub zero file integration routes — upload-init chain", () => {
  it("gwt-wt-wt: 200 returns a presigned upload URL with public S3 endpoint, body shape + sanitized filename + S3 key", async () => {
    // Given: S3 endpoint env + a fixture + an init client.
    mockEnv("S3_ENDPOINT", "http://internal-s3.test");
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.test");
    const fixture = await seedFixture();
    const client = setupApp({ context })(integrationsGithubUploadInitContract);

    // When + Then: 200 — the response body matches the
    // expected shape + the S3 key is sanitized.
    const response = await accept(
      client.init({
        body: {
          filename: "daily report.pdf",
          contentType: "application/pdf",
          length: 1234,
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:write"],
          })}`,
        },
      }),
      [200],
    );
    expect(response.body).toMatchObject({
      uploadUrl: "https://r2.example.com/upload?sig=test",
      filename: "daily_report.pdf",
      contentType: "application/pdf",
      size: 1234,
    });
    expect(response.body.uploadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.body.fileUrl).toBe(
      `https://cdn.vm7.io/artifacts/${fixture.userId}/${response.body.uploadId}/daily_report.pdf`,
    );

    const calls = context.mocks.s3.getSignedUrl.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const command = calls[0]?.[1];
    expect(command).toHaveProperty("input.Bucket", "test-user-artifacts");
    expect(command).toHaveProperty(
      "input.Key",
      `artifacts/${fixture.userId}/${response.body.uploadId}/daily_report.pdf`,
    );
  });
});

describe("BDD GitHub zero file integration routes — upload-complete chain", () => {
  it("gwt-wt-wt: 200 posts the URL to GitHub + records the run artifact with full metadata", async () => {
    // Given: a fixture + a run + mocked GitHub credentials
    // + a token mock + an S3 list of one uploaded object.
    const fixture = await seedFixture();
    const run = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: fixture.composeId,
        triggerSource: "github",
      },
      context.signal,
    );
    mockGitHubAppCredentials();
    setupGitHubTokenMock(fixture.remoteInstallationId);

    const uploadId = randomUUID();
    const s3Key = `artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    const fileUrl = `https://cdn.vm7.io/artifacts/${fixture.userId}/${uploadId}/report.pdf`;
    mocks.s3.listObjects([
      { bucket: "test-user-artifacts", key: s3Key, size: 1234 },
    ]);

    let capturedCommentBody: string | undefined;
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
        async ({ request, params }) => {
          expect(params.owner).toBe("vm0-ai");
          expect(params.repo).toBe("vm0");
          expect(params.issueNumber).toBe("42");
          expect(request.headers.get("authorization")).toBe(
            "Bearer ghs_test_token",
          );
          const body = (await request.json()) as Record<string, unknown>;
          capturedCommentBody =
            typeof body.body === "string" ? body.body : undefined;
          return HttpResponse.json({ id: 98_765 });
        },
      ),
    );

    const client = setupApp({ context })(
      integrationsGithubUploadCompleteContract,
    );

    // When + Then: 200 — the URL is posted to GitHub as a
    // comment with the caption + the response body matches
    // the expected shape.
    const response = await accept(
      client.complete({
        body: {
          uploadId,
          repo: "vm0-ai/vm0",
          issueNumber: 42,
          contentType: "application/pdf",
          caption: "Daily report",
        },
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            runId: run.runId,
            capabilities: ["github:write"],
          })}`,
        },
      }),
      [200],
    );

    expect(capturedCommentBody).toBe(
      `Daily report\n\n[report.pdf](${fileUrl})`,
    );
    expect(response.body).toMatchObject({
      commentId: "98765",
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      filename: "report.pdf",
      mimetype: "application/pdf",
      size: 1234,
      url: fileUrl,
    });

    // Then: the run artifact row is recorded with the
    // full metadata.
    const rows = await findUploadedFiles({
      runId: run.runId,
      externalId: "98765",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: run.runId,
      source: "github",
      externalId: "98765",
      userId: fixture.userId,
      orgId: fixture.orgId,
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      url: fileUrl,
      metadata: {
        repo: "vm0-ai/vm0",
        issueNumber: 42,
        uploadId,
        s3Key,
        sourceUrl: fileUrl,
        caption: "Daily report",
        githubComment: { id: "98765" },
      },
    });
  });
});
