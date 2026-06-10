import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { integrationsSlackUploadInitContract } from "@vm0/api-contracts/contracts/integrations";
import {
  testSlackStateContract,
  type TestSlackStatePostResponse,
} from "@vm0/api-contracts/contracts/test-slack-state";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();

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
  return setupApp({ context })(integrationsSlackUploadInitContract);
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

async function createSlackInstallation(): Promise<SlackWriteAuth> {
  mockEnv("ENV", "development");
  const teamId = `T_UPLOAD_INIT_${suffix().toUpperCase()}`;
  const userId = `user_slack_upload_${suffix()}`;
  const orgId = `org_slack_upload_${suffix()}`;
  mockMembership(userId, orgId);

  const response = await accept(
    stateClient().post({
      body: {
        team_id: teamId,
        slack_user_id: `U_UPLOAD_${suffix().toUpperCase()}`,
        workspace_name: "Slack Upload Workspace",
        bot_user_id: "U_UPLOAD_BOT",
      },
    }),
    [200],
  );

  await trackSlackInstallation(
    Promise.resolve({ teamId, response: response.body }),
  );
  return slackWriteAuth({
    userId: response.body.vm0_user_id,
    orgId: response.body.org_id,
  });
}

describe("POST /api/zero/integrations/slack/upload-file/init BDD", () => {
  beforeEach(() => {
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/abc",
      file_id: "F-mock-file",
    });
  });

  it("requires authentication, Slack write capability, and an installed Slack workspace", async () => {
    const unauthenticated = await accept(
      client().init({
        body: { filename: "report.pdf", length: 100 },
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
      client().init({
        body: { filename: "report.pdf", length: 100 },
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
      client().init({
        body: { filename: "report.pdf", length: 100 },
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
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("validates the upload request before asking Slack for an upload URL", async () => {
    const auth = await createSlackInstallation();

    const response = await accept(
      client().init({
        body: { filename: "", length: 0 },
        headers: auth.headers,
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns Slack upload details and forwards Slack upload URL errors", async () => {
    const auth = await createSlackInstallation();

    const success = await accept(
      client().init({
        body: { filename: "quarterly.csv", length: 4096 },
        headers: auth.headers,
      }),
      [200],
    );

    expect(success.body).toStrictEqual({
      uploadUrl: "https://files.slack.com/upload/v1/abc",
      fileId: "F-mock-file",
    });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenLastCalledWith({ filename: "quarterly.csv", length: 4096 });

    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: false,
      error: "invalid_length",
    });
    const nonOk = await accept(
      client().init({
        body: { filename: "bad.csv", length: 1 },
        headers: auth.headers,
      }),
      [400],
    );

    expect(nonOk.body.error).toStrictEqual({
      message: "Slack API error: invalid_length",
      code: "SLACK_ERROR",
    });

    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: true,
      file_id: "F-missing-upload-url",
    });
    const malformed = await accept(
      client().init({
        body: { filename: "missing-url.csv", length: 1 },
        headers: auth.headers,
      }),
      [400],
    );

    expect(malformed.body.error).toStrictEqual({
      message: "Slack API error: unknown error",
      code: "SLACK_ERROR",
    });

    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/missing-file",
    });
    const missingFileId = await accept(
      client().init({
        body: { filename: "missing-file-id.csv", length: 1 },
        headers: auth.headers,
      }),
      [400],
    );

    expect(missingFileId.body.error).toStrictEqual({
      message: "Slack API error: unknown error",
      code: "SLACK_ERROR",
    });

    context.mocks.slack.files.getUploadURLExternal.mockRejectedValueOnce(
      Object.assign(new Error("invalid_filename"), {
        data: { ok: false, error: "invalid_filename" },
      }),
    );
    const platformError = await accept(
      client().init({
        body: { filename: "../bad.exe", length: 1 },
        headers: auth.headers,
      }),
      [400],
    );

    expect(platformError.body.error).toStrictEqual({
      message: "Slack API error: invalid_filename",
      code: "SLACK_ERROR",
    });
  });
});
