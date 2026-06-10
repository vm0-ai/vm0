import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { integrationsSlackUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

// BDD migration of the legacy
// `zero-integrations-slack-upload-complete.test.ts`. The 7
// legacy `it()`s collapse into 2 BDD `it()`s: (1) auth +
// precondition chain (401 no auth → 403 sandbox without
// `slack:write` → 404 no installation → 400 SLACK_ERROR
// when Slack file info fails), (2) success chain (200
// records a Slack upload for a run-scoped zero token +
// DB row written + completeUploadExternal called with
// expected payload → 200 does not record a run association
// for ordinary Clerk session auth → 200 is idempotent for
// repeated completion calls for the same run file).
//
// Service-Level Exception: `runUploadedFiles` rows are
// read directly via `writeDb$` because no public follow-up
// GET endpoint exists.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities?: readonly string[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: (args.capabilities ?? ["slack:write"]) as never,
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

interface RunScopedContext {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}

function findUploadedFiles(externalId: string) {
  const writeDb = store.set(writeDb$);
  return writeDb
    .select()
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.source, "slack"),
        eq(runUploadedFiles.externalId, externalId),
      ),
    );
}

function createSlackUploadHarness(): {
  readonly slackFixtures: SlackIntegrationFixture[];
  readonly memberships: OrgMembershipFixture[];
  readonly insightFixtures: UsageInsightFixture[];
} {
  return { slackFixtures: [], memberships: [], insightFixtures: [] };
}

function mockSlackFileInfo(fileId: string): void {
  context.mocks.slack.files.info.mockResolvedValue({
    ok: true,
    file: {
      id: fileId,
      name: "report.csv",
      title: "Slack Report",
      mimetype: "text/csv",
      filetype: "csv",
      size: 42,
      permalink: `https://slack.example/files/${fileId}`,
    },
  });
}

async function seedBaseContext(args: {
  readonly memberships: OrgMembershipFixture[];
  readonly insightFixtures: UsageInsightFixture[];
}): Promise<{ orgId: string; userId: string }> {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = `user_${randomUUID().slice(0, 8)}`;
  const membership = await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  args.memberships.push(membership);
  args.insightFixtures.push({ orgId, userId });
  return { orgId, userId };
}

async function seedWithInstallation(args: {
  readonly slackFixtures: SlackIntegrationFixture[];
  readonly memberships: OrgMembershipFixture[];
  readonly insightFixtures: UsageInsightFixture[];
}): Promise<{ orgId: string; userId: string }> {
  const base = await seedBaseContext(args);
  const fixture = await store.set(
    seedSlackOrgInstallation$,
    { orgId: base.orgId },
    context.signal,
  );
  args.slackFixtures.push(fixture);
  return base;
}

async function seedRunScoped(args: {
  readonly slackFixtures: SlackIntegrationFixture[];
  readonly memberships: OrgMembershipFixture[];
  readonly insightFixtures: UsageInsightFixture[];
}): Promise<RunScopedContext> {
  const base = await seedWithInstallation(args);
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: base.orgId, userId: base.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: base.orgId,
      userId: base.userId,
      composeId,
      triggerSource: "slack",
    },
    context.signal,
  );
  return { orgId: base.orgId, userId: base.userId, runId };
}

describe("BDD POST /api/zero/integrations/slack/upload-file/complete — auth + precondition chain", () => {
  beforeEach(() => {
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
  });

  it("gwt-wt-wt: 401 no auth → 403 sandbox without `slack:write` → 404 no installation → 400 SLACK_ERROR when Slack file info fails", async () => {
    // Given: no auth token.
    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );

    // When + Then: 401.
    const noAuth = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a sandbox token without `slack:write`.
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const sandboxJwt = sandboxToken({ userId, orgId, runId });

    // When + Then: 403.
    const sandbox = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${sandboxJwt}` },
      }),
      [403],
    );
    expect(sandbox.body.error.message).toContain("slack:write");

    // Given: a valid zero token but no Slack installation
    // for the org.
    const { orgId: noInstallOrgId, userId: noInstallUserId } =
      await seedBaseContext({
        memberships: [],
        insightFixtures: [],
      });
    const noInstallToken = zeroToken({
      userId: noInstallUserId,
      orgId: noInstallOrgId,
      runId: `run_${randomUUID()}`,
    });

    // When + Then: 404.
    const noInstall = await accept(
      client.complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${noInstallToken}` },
      }),
      [404],
    );
    expect(noInstall.body.error.message).toContain("No Slack installation");

    // Given: a run-scoped zero token + Slack rejects
    // `files.info` with `file_not_found`.
    const runCtx = await seedRunScoped({
      slackFixtures: [],
      memberships: [],
      insightFixtures: [],
    });
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    const token = zeroToken({
      userId: runCtx.userId,
      orgId: runCtx.orgId,
      runId: runCtx.runId,
    });
    context.mocks.slack.files.info.mockRejectedValueOnce(
      Object.assign(new Error("file_not_found"), {
        data: { ok: false, error: "file_not_found" },
      }),
    );

    // When + Then: 400 — SLACK_ERROR; no upload row is
    // recorded.
    const slackError = await accept(
      client.complete({
        body: { fileId, channel: "C123" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );
    expect(slackError.body.error.code).toBe("SLACK_ERROR");
    expect(slackError.body.error.message).toContain("file_not_found");
    await expect(findUploadedFiles(fileId)).resolves.toHaveLength(0);
  });
});

describe("BDD POST /api/zero/integrations/slack/upload-file/complete — success chain", () => {
  const harness = createSlackUploadHarness();

  beforeEach(() => {
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
  });

  afterEach(async () => {
    while (harness.slackFixtures.length > 0) {
      const fixture = harness.slackFixtures.pop();
      if (fixture) {
        await store.set(
          deleteSlackIntegrationFixture$,
          fixture,
          context.signal,
        );
      }
    }
    while (harness.insightFixtures.length > 0) {
      const fixture = harness.insightFixtures.pop();
      if (fixture) {
        await store.set(deleteUsageInsightFixture$, fixture, context.signal);
      }
    }
    while (harness.memberships.length > 0) {
      const membership = harness.memberships.pop();
      if (membership) {
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 200 records a Slack upload for a run-scoped zero token + DB row written + completeUploadExternal called with expected payload → 200 does not record a run association for ordinary Clerk session auth → 200 is idempotent for repeated completion calls for the same run file", async () => {
    // Given: a run-scoped zero token + a fresh
    // installation.
    const { orgId, userId, runId } = await seedRunScoped(harness);
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const token = zeroToken({ userId, orgId, runId });

    // When: complete a Slack upload.
    const client = setupApp({ context })(
      integrationsSlackUploadCompleteContract,
    );
    const response = await accept(
      client.complete({
        body: {
          fileId,
          channel: "C123",
          threadTs: "123.456",
          title: "Quarterly report",
          initialComment: "Uploaded from a run",
        },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    // Then: 200 + the response matches the expected
    // shape + completeUploadExternal is called with the
    // expected payload + the DB row is written.
    expect(response.body).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenLastCalledWith({
      files: [{ id: fileId, title: "Quarterly report" }],
      channel_id: "C123",
      thread_ts: "123.456",
      initial_comment: "Uploaded from a run",
    });
    const rows = await findUploadedFiles(fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId,
      source: "slack",
      externalId: fileId,
      userId,
      orgId,
      filename: "Quarterly report",
      contentType: "text/csv",
      sizeBytes: 42,
      url: `https://slack.example/files/${fileId}`,
      metadata: {
        channel: "C123",
        threadTs: "123.456",
        title: "Quarterly report",
        initialComment: "Uploaded from a run",
        slackFile: {
          id: fileId,
          name: "report.csv",
          title: "Slack Report",
          mimetype: "text/csv",
          filetype: "csv",
        },
      },
    });

    // Given: a fresh installation + a Clerk session.
    const sessionCtx = await seedWithInstallation(harness);
    const sessionFileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(sessionFileId);
    mocks.clerk.session(sessionCtx.userId, sessionCtx.orgId);

    // When + Then: 200 — the response is returned but no
    // run association is recorded (no row in DB).
    const sessionResponse = await accept(
      client.complete({
        body: {
          fileId: sessionFileId,
          channel: "C123",
          title: "Session upload",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(sessionResponse.body).toMatchObject({
      fileId: sessionFileId,
      permalink: `https://slack.example/files/${sessionFileId}`,
    });
    await expect(findUploadedFiles(sessionFileId)).resolves.toHaveLength(0);

    // Given: a run-scoped zero token for a new
    // installation.
    const retryCtx = await seedRunScoped(harness);
    const retryFileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(retryFileId);
    const retryToken = zeroToken({
      userId: retryCtx.userId,
      orgId: retryCtx.orgId,
      runId: retryCtx.runId,
    });
    const retryBody = {
      fileId: retryFileId,
      channel: "C123",
      title: "Retry upload",
    };

    // When: complete the same upload twice.

    // Then: both calls return 200 + only one DB row is
    // recorded (idempotent).
    await accept(
      client.complete({
        body: retryBody,
        headers: { authorization: `Bearer ${retryToken}` },
      }),
      [200],
    );
    await accept(
      client.complete({
        body: retryBody,
        headers: { authorization: `Bearer ${retryToken}` },
      }),
      [200],
    );
    const retryRows = await findUploadedFiles(retryFileId);
    expect(retryRows).toHaveLength(1);
  });
});
