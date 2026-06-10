import { randomUUID } from "node:crypto";

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
import { createFixtureTracker } from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-integrations-slack-upload-init.test.ts`. The 8 legacy
// `it()`s collapse into 2 BDD `it()`s: (1) auth + capability
// chain (401 unauth → 403 sandbox missing slack:write → 404
// no Slack installation), (2) 200/400 success chain (400
// invalid body → 200 happy path + Slack called once with
// expected args → 400 SLACK_ERROR on Slack non-ok → 400
// SLACK_ERROR on malformed Slack response → 400 SLACK_ERROR
// on Slack platform error).
//
// Service-Level Exception: the Slack external API is mocked
// via `context.mocks.slack.files.getUploadURLExternal` (the
// only viable way to drive the route's SLACK_ERROR branches).

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

const trackSlack = createFixtureTracker<SlackIntegrationFixture>((fixture) => {
  return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
});

const trackMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);

async function seedWithInstallation(): Promise<{
  orgId: string;
  userId: string;
}> {
  const orgId = `org_${randomUUID().slice(0, 8)}`;
  const userId = `user_${randomUUID().slice(0, 8)}`;
  await trackMembership(
    store.set(
      seedOrgMembership$,
      { orgId, userId, role: "admin" },
      context.signal,
    ),
  );
  await trackSlack(
    store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
  );
  return { orgId, userId };
}

describe("BDD POST /api/zero/integrations/slack/upload-file/init — auth + capability chain", () => {
  it("gwt-wt-wt: 401 unauth → 403 sandbox missing slack:write → 404 no Slack installation", async () => {
    const client = setupApp({ context })(integrationsSlackUploadInitContract);

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a sandbox token lacking slack:write.
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID()}`;
    const token = sandboxToken({ userId, orgId, runId });

    // When + Then: 403.
    const noCap = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    expect(noCap.body.error.message).toContain("slack:write");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(0);

    // Given: an admin + a token but no Slack installation.
    await trackMembership(
      store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const zeroTok = zeroToken({ userId, orgId, runId: `run_${randomUUID()}` });

    // When + Then: 404.
    const noInstall = await accept(
      client.init({
        body: { filename: "report.pdf", length: 100 },
        headers: { authorization: `Bearer ${zeroTok}` },
      }),
      [404],
    );
    expect(noInstall.body.error.message).toContain("No Slack installation");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(0);
  });
});

describe("BDD POST /api/zero/integrations/slack/upload-file/init — 200/400 success chain", () => {
  it("gwt-wt-wt: 400 invalid body → 200 happy path + Slack called with expected args → 400 SLACK_ERROR on Slack non-ok → 400 SLACK_ERROR on malformed Slack response → 400 SLACK_ERROR on Slack platform error", async () => {
    // Given: a default Slack upload-URL response (mirrors the
    // legacy `beforeEach` default).
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload/v1/abc",
      file_id: "F-mock-file",
    });

    const client = setupApp({ context })(integrationsSlackUploadInitContract);

    // Given: a seeded Slack installation.
    const seeded = await seedWithInstallation();
    const zeroTok = zeroToken({
      userId: seeded.userId,
      orgId: seeded.orgId,
      runId: `run_${randomUUID()}`,
    });

    // When + Then: 400 on an empty filename + zero length.
    const badBody = await accept(
      client.init({
        body: { filename: "", length: 0 },
        headers: { authorization: `Bearer ${zeroTok}` },
      }),
      [400],
    );
    expect(badBody.body.error.code).toBe("BAD_REQUEST");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(0);

    // When + Then: 200 happy path + Slack called with the
    // expected args.
    const happy = await accept(
      client.init({
        body: { filename: "quarterly.csv", length: 4096 },
        headers: { authorization: `Bearer ${zeroTok}` },
      }),
      [200],
    );
    expect(happy.body).toMatchObject({
      uploadUrl: "https://files.slack.com/upload/v1/abc",
      fileId: "F-mock-file",
    });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenLastCalledWith({ filename: "quarterly.csv", length: 4096 });
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(1);

    // Given: a fresh token + Slack returns a non-ok response.
    const nonOk = await seedWithInstallation();
    const nonOkTok = zeroToken({
      userId: nonOk.userId,
      orgId: nonOk.orgId,
      runId: `run_${randomUUID()}`,
    });
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: false,
      error: "invalid_length",
    });

    // When + Then: 400 SLACK_ERROR.
    const slackError = await accept(
      client.init({
        body: { filename: "bad.csv", length: 1 },
        headers: { authorization: `Bearer ${nonOkTok}` },
      }),
      [400],
    );
    expect(slackError.body.error.code).toBe("SLACK_ERROR");
    expect(slackError.body.error.message).toContain("invalid_length");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(2);

    // Given: a fresh token + Slack returns a malformed
    // response (no upload_url).
    const malformed = await seedWithInstallation();
    const malformedTok = zeroToken({
      userId: malformed.userId,
      orgId: malformed.orgId,
      runId: `run_${randomUUID()}`,
    });
    context.mocks.slack.files.getUploadURLExternal.mockResolvedValueOnce({
      ok: true,
      file_id: "F-missing-upload-url",
    });

    // When + Then: 400 SLACK_ERROR (unknown error).
    const slackMalformed = await accept(
      client.init({
        body: { filename: "missing-url.csv", length: 1 },
        headers: { authorization: `Bearer ${malformedTok}` },
      }),
      [400],
    );
    expect(slackMalformed.body.error.code).toBe("SLACK_ERROR");
    expect(slackMalformed.body.error.message).toContain("unknown error");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(3);

    // Given: a fresh token + Slack rejects with a platform
    // error.
    const platform = await seedWithInstallation();
    const platformTok = zeroToken({
      userId: platform.userId,
      orgId: platform.orgId,
      runId: `run_${randomUUID()}`,
    });
    context.mocks.slack.files.getUploadURLExternal.mockRejectedValueOnce(
      Object.assign(new Error("invalid_filename"), {
        data: { ok: false, error: "invalid_filename" },
      }),
    );

    // When + Then: 400 SLACK_ERROR.
    const slackPlatform = await accept(
      client.init({
        body: { filename: "../bad.exe", length: 1 },
        headers: { authorization: `Bearer ${platformTok}` },
      }),
      [400],
    );
    expect(slackPlatform.body.error.code).toBe("SLACK_ERROR");
    expect(slackPlatform.body.error.message).toContain("invalid_filename");
    expect(
      context.mocks.slack.files.getUploadURLExternal,
    ).toHaveBeenCalledTimes(4);
  });
});
