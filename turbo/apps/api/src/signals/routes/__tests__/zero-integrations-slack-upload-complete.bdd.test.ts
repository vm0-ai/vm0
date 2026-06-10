import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { integrationsSlackUploadCompleteContract } from "@vm0/api-contracts/contracts/integrations";
import {
  testSlackStateContract,
  type TestSlackStatePostResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface SeededSlackInstallation {
  readonly teamId: string;
  readonly response: TestSlackStatePostResponse;
}

interface SlackWriteAuth {
  readonly headers: { readonly authorization: string };
  readonly userId: string;
  readonly orgId: string;
}

function client() {
  return setupApp({ context })(integrationsSlackUploadCompleteContract);
}

function stateClient() {
  return setupApp({ context })(testSlackStateContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function suffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    iat: seconds,
    exp: seconds + 60,
  });
}

function mockMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [{ id: userId }],
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId }, role: "org:member" }],
  });
}

function slackWriteAuth(args: {
  readonly userId: string;
  readonly orgId: string;
}): SlackWriteAuth {
  mockMembership(args.userId, args.orgId);
  const token = zeroToken({
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["slack:write"],
  });
  return {
    headers: { authorization: `Bearer ${token}` },
    userId: args.userId,
    orgId: args.orgId,
  };
}

async function cleanupSlackInstallation(
  installation: SeededSlackInstallation,
): Promise<void> {
  mockEnv("ENV", "development");
  await accept(
    stateClient().delete({ query: { team_id: installation.teamId } }),
    [200],
  );
}

const trackSlackInstallation = createFixtureTracker<SeededSlackInstallation>(
  cleanupSlackInstallation,
);

async function createSlackInstallation(): Promise<TestSlackStatePostResponse> {
  mockEnv("ENV", "development");
  const teamId = `T_UPLOAD_COMPLETE_${suffix().toUpperCase()}`;
  const userId = `user_slack_complete_${suffix()}`;
  const orgId = `org_slack_complete_${suffix()}`;
  mockMembership(userId, orgId);

  const response = await accept(
    stateClient().post({
      body: {
        team_id: teamId,
        slack_user_id: `U_COMPLETE_${suffix().toUpperCase()}`,
        workspace_name: "Slack Upload Complete Workspace",
        bot_user_id: "U_COMPLETE_BOT",
      },
    }),
    [200],
  );

  await trackSlackInstallation(
    Promise.resolve({ teamId, response: response.body }),
  );
  return response.body;
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

describe("POST /api/zero/integrations/slack/upload-file/complete BDD", () => {
  beforeEach(() => {
    context.mocks.slack.files.completeUploadExternal.mockResolvedValue({
      ok: true,
    });
    context.mocks.slack.files.info.mockResolvedValue({
      ok: true,
      file: undefined,
    });
  });

  it("requires authentication, Slack write capability, and an installed Slack workspace", async () => {
    const unauthenticated = await accept(
      client().complete({
        body: { fileId: "F123", channel: "C123" },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const missingCapabilityToken = sandboxToken({
      userId: `user_${suffix()}`,
      orgId: `org_${suffix()}`,
      runId: `run_${randomUUID()}`,
    });
    const missingCapability = await accept(
      client().complete({
        body: { fileId: "F123", channel: "C123" },
        headers: { authorization: `Bearer ${missingCapabilityToken}` },
      }),
      [403],
    );

    expect(missingCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: slack:write",
        code: "FORBIDDEN",
      },
    });

    const userId = `user_${suffix()}`;
    const orgId = `org_${suffix()}`;
    const noInstallationAuth = slackWriteAuth({ userId, orgId });
    const missingInstallation = await accept(
      client().complete({
        body: { fileId: "F123", channel: "C123" },
        headers: noInstallationAuth.headers,
      }),
      [404],
    );

    expect(missingInstallation.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this organization",
        code: "NOT_FOUND",
      },
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
  });

  it("validates the completion request before calling Slack", async () => {
    const installation = await createSlackInstallation();
    mocks.clerk.session(installation.vm0_user_id, installation.org_id);

    const response = await accept(
      client().complete({
        body: { fileId: "", channel: "" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).not.toHaveBeenCalled();
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();
  });

  it("completes a Slack upload and returns the Slack permalink", async () => {
    const installation = await createSlackInstallation();
    mocks.clerk.session(installation.vm0_user_id, installation.org_id);
    const fileId = `F-${suffix().toUpperCase()}`;
    mockSlackFileInfo(fileId);

    const response = await accept(
      client().complete({
        body: {
          fileId,
          channel: "C123",
          threadTs: "123.456",
          title: "Quarterly report",
          initialComment: "Uploaded from a session",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      fileId,
      permalink: `https://slack.example/files/${fileId}`,
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenLastCalledWith({
      files: [{ id: fileId, title: "Quarterly report" }],
      channel_id: "C123",
      thread_ts: "123.456",
      initial_comment: "Uploaded from a session",
    });
    expect(context.mocks.slack.files.info).toHaveBeenLastCalledWith({
      file: fileId,
    });

    const fileWithoutInfo = `F-${suffix().toUpperCase()}`;
    context.mocks.slack.files.info.mockResolvedValueOnce({
      ok: true,
      file: undefined,
    });
    const emptyPermalink = await accept(
      client().complete({
        body: { fileId: fileWithoutInfo, channel: "C123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(emptyPermalink.body).toStrictEqual({
      fileId: fileWithoutInfo,
      permalink: "",
    });
  });

  it("forwards Slack complete and file info API errors", async () => {
    const installation = await createSlackInstallation();
    mocks.clerk.session(installation.vm0_user_id, installation.org_id);

    context.mocks.slack.files.completeUploadExternal.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );
    const completeError = await accept(
      client().complete({
        body: { fileId: "F-missing-channel", channel: "C-missing" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(completeError.body.error).toStrictEqual({
      message: "Slack API error: channel_not_found",
      code: "SLACK_ERROR",
    });
    expect(context.mocks.slack.files.info).not.toHaveBeenCalled();

    context.mocks.slack.files.info.mockRejectedValueOnce(
      Object.assign(new Error("file_not_found"), {
        data: { ok: false, error: "file_not_found" },
      }),
    );
    const infoError = await accept(
      client().complete({
        body: { fileId: "F-missing-file", channel: "C123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(infoError.body.error).toStrictEqual({
      message: "Slack API error: file_not_found",
      code: "SLACK_ERROR",
    });
    expect(
      context.mocks.slack.files.completeUploadExternal,
    ).toHaveBeenLastCalledWith({
      files: [{ id: "F-missing-file", title: undefined }],
      channel_id: "C123",
      thread_ts: undefined,
      initial_comment: undefined,
    });
  });
});
