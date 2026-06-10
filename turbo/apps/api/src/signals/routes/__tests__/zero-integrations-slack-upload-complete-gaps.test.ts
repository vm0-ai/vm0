import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { integrationsSlackUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface RunScopedContext {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: ["slack:write"],
    iat: seconds,
    exp: seconds + 60,
  });
}

function client() {
  return setupApp({ context })(integrationsSlackUploadCompleteContract);
}

describe("POST /api/zero/integrations/slack/upload-file/complete helper gaps", () => {
  const slackFixtures: SlackIntegrationFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];
  const insightFixtures: UsageInsightFixture[] = [];

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

  beforeEach(() => {
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
  });

  afterEach(async () => {
    while (slackFixtures.length > 0) {
      const fixture = slackFixtures.pop();
      if (fixture) {
        await store.set(
          deleteSlackIntegrationFixture$,
          fixture,
          context.signal,
        );
      }
    }
    while (insightFixtures.length > 0) {
      const fixture = insightFixtures.pop();
      if (fixture) {
        await store.set(deleteUsageInsightFixture$, fixture, context.signal);
      }
    }
    while (memberships.length > 0) {
      const membership = memberships.pop();
      if (membership) {
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

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

  async function seedBaseContext(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    memberships.push(membership);
    insightFixtures.push({ orgId, userId });
    return { orgId, userId };
  }

  async function seedWithInstallation(): Promise<{
    orgId: string;
    userId: string;
  }> {
    const base = await seedBaseContext();
    const fixture = await store.set(
      seedSlackOrgInstallation$,
      { orgId: base.orgId },
      context.signal,
    );
    slackFixtures.push(fixture);
    return base;
  }

  async function seedRunScoped(): Promise<RunScopedContext> {
    const base = await seedWithInstallation();
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

  it("gap-slack-upload-complete-01: does not record a row when Slack file info fails", async () => {
    const { orgId, userId, runId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    context.mocks.slack.files.info.mockRejectedValueOnce(
      Object.assign(new Error("file_not_found"), {
        data: { ok: false, error: "file_not_found" },
      }),
    );

    const response = await accept(
      client().complete({
        body: { fileId, channel: "C123" },
        headers: {
          authorization: `Bearer ${zeroToken({ userId, orgId, runId })}`,
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("file_not_found");
    await expect(findUploadedFiles(fileId)).resolves.toHaveLength(0);
  });

  it("gap-slack-upload-complete-01: records a Slack upload for a run-scoped zero token", async () => {
    const { orgId, userId, runId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);

    const response = await accept(
      client().complete({
        body: {
          fileId,
          channel: "C123",
          threadTs: "123.456",
          title: "Quarterly report",
          initialComment: "Uploaded from a run",
        },
        headers: {
          authorization: `Bearer ${zeroToken({ userId, orgId, runId })}`,
        },
      }),
      [200],
    );

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
  });

  it("gap-slack-upload-complete-01: does not record a run association for ordinary clerk session auth", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      client().complete({
        body: { fileId, channel: "C123", title: "Session upload" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });
    await expect(findUploadedFiles(fileId)).resolves.toHaveLength(0);
  });

  it("gap-slack-upload-complete-01: is idempotent for repeated completion calls for the same run file", async () => {
    const { orgId, userId, runId } = await seedRunScoped();
    const fileId = `F-${randomUUID().slice(0, 8)}`;
    mockSlackFileInfo(fileId);
    const body = { fileId, channel: "C123", title: "Retry upload" };

    await accept(
      client().complete({
        body,
        headers: {
          authorization: `Bearer ${zeroToken({ userId, orgId, runId })}`,
        },
      }),
      [200],
    );
    await accept(
      client().complete({
        body,
        headers: {
          authorization: `Bearer ${zeroToken({ userId, orgId, runId })}`,
        },
      }),
      [200],
    );

    await expect(findUploadedFiles(fileId)).resolves.toHaveLength(1);
  });
});
