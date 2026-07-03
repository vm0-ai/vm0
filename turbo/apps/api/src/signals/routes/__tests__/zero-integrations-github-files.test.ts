import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
} from "@vm0/api-contracts/contracts/integrations";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { signSandboxJwtForTests } from "../../auth/tokens";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const github = createGithubBddApi(context);

interface GitHubFileFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly remoteInstallationId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
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

describe("GitHub zero file integration routes", () => {
  const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });
  async function seedFixture(): Promise<GitHubFileFixture> {
    const fixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const actor: ApiTestUser = {
      userId: fixture.userId,
      orgId: fixture.orgId,
      orgRole: "org:admin",
      email: `${fixture.userId}@example.com`,
    };
    const install = await github.installGithubApp(actor, compose.composeId, {
      targetLogin: "bdd-files-org",
    });
    return {
      ...fixture,
      composeId: compose.composeId,
      remoteInstallationId: install.remoteInstallationId,
    };
  }

  it("streams a GitHub context file from an allowed URL", async () => {
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

    const app = createApp({ signal: context.signal });
    const query = new URLSearchParams({
      url: fileUrl,
      filename: "screenshot.png",
    });
    const response = await app.request(
      `/api/zero/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:read"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("screenshot.png");
    expect(response.headers.get("x-file-mimetype")).toBe("image/png");
    await expect(response.text()).resolves.toBe("png-bytes");
  });

  it("uses the GitHub URL filename when no filename hint is provided", async () => {
    const fixture = await seedFixture();
    const fileUrl =
      "https://raw.githubusercontent.com/vm0-ai/vm0/main/github-file.png";
    server.use(
      http.get(fileUrl, ({ request }) => {
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

    const app = createApp({ signal: context.signal });
    const query = new URLSearchParams({ url: fileUrl });
    const response = await app.request(
      `/api/zero/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:read"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-file-name")).toBe("github-file.png");
    await expect(response.text()).resolves.toBe("artifact-bytes");
  });

  it("rejects non-GitHub file URLs", async () => {
    const fixture = await seedFixture();

    const app = createApp({ signal: context.signal });
    const query = new URLSearchParams({
      url: "https://example.com/file.png",
    });
    const response = await app.request(
      `/api/zero/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:read"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("requires github read capability for context file downloads", async () => {
    const fixture = await seedFixture();
    const app = createApp({ signal: context.signal });
    const query = new URLSearchParams({
      url: "https://github.com/user-attachments/assets/abc123",
    });

    const response = await app.request(
      `/api/zero/integrations/github/download-file?${query.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${zeroToken({
            userId: fixture.userId,
            orgId: fixture.orgId,
            capabilities: ["github:write"],
          })}`,
        },
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("returns a presigned upload URL for GitHub file delivery", async () => {
    mockEnv("S3_ENDPOINT", "http://internal-s3.test");
    mockEnv("S3_PUBLIC_ENDPOINT", "https://public-s3.test");
    const fixture = await seedFixture();
    const client = setupApp({ context })(integrationsGithubUploadInitContract);

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

  it("posts an uploaded file URL to GitHub and records the run artifact", async () => {
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
  });
});
