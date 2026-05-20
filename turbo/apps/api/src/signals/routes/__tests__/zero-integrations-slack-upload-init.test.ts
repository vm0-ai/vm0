import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { integrationsSlackUploadInitContract } from "@vm0/api-contracts/contracts/integrations";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

const context = testContext();
const store = createStore();

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

describe("POST /api/zero/integrations/slack/upload-file/init", () => {
  const slackFixtures: SlackIntegrationFixture[] = [];
  const memberships: OrgMembershipFixture[] = [];

  beforeEach(() => {
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/abc",
      file_id: "F-mock-file",
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
    while (memberships.length > 0) {
      const membership = memberships.pop();
      if (membership) {
        await store.set(deleteOrgMembership$, membership, context.signal);
      }
    }
  });

  async function seedWithInstallation(): Promise<{
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
    const fixture = await store.set(
      seedSlackOrgInstallation$,
      { orgId },
      context.signal,
    );
    slackFixtures.push(fixture);
    return { orgId, userId };
  }

  it("returns 401 when no auth token is provided", async () => {
    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when sandbox token lacks slack:write", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const token = sandboxToken({ userId, orgId, runId });

    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("slack:write");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns 404 when no Slack installation exists for org", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const membership = await store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    );
    memberships.push(membership);
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [404],
    );
    expect(response.body.error.message).toContain("No Slack installation");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid request bodies", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "", length: 0 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).not.toHaveBeenCalled();
  });

  it("returns a Slack-issued upload URL and file id on the happy path", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "quarterly.csv", length: 4096 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      uploadUrl: "https://files.slack.com/upload/v1/abc",
      fileId: "F-mock-file",
    });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenLastCalledWith({ filename: "quarterly.csv", length: 4096 });
  });

  it("forwards Slack non-ok upload URL responses as 400 SLACK_ERROR", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: false,
      error: "invalid_length",
    });

    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "bad.csv", length: 1 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("invalid_length");
  });

  it("forwards malformed Slack upload URL responses as 400 SLACK_ERROR", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: true,
      file_id: "F-missing-upload-url",
    });

    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "missing-url.csv", length: 1 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("unknown error");
  });

  it("forwards Slack platform errors as 400 SLACK_ERROR", async () => {
    const { orgId, userId } = await seedWithInstallation();
    const token = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    context.mocks.slack.files.getUploadURLExternal.mockRejectedValueOnce(
      Object.assign(new Error("invalid_filename"), {
        data: { ok: false, error: "invalid_filename" },
      }),
    );

    const client = setupApp({ context })(integrationsSlackUploadInitContract);
    const response = await accept(
      client.init({
        body: { filename: "../bad.exe", length: 1 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("SLACK_ERROR");
    expect(response.body.error.message).toContain("invalid_filename");
  });
});
