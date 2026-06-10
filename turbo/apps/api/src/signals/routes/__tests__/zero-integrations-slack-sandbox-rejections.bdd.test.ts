import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi } from "./helpers/api-bdd";

// API-first BDD coverage for the sandbox-facing Slack message + file-upload
// auth/capability rejections. These endpoints take a sandbox/zero run token; a
// missing token is unauthorized and a sandbox token without `slack:write` is
// forbidden before any Slack call. The success / no-installation (404) /
// invalid-body (400) cases need a zero token whose org has a seeded membership
// and Slack installation (GAP-CONNECTOR-CONNECT), which the helper's internal
// random orgIds cannot align with, so they stay in the kept legacy. See
// `api.bdd.md` (CHAIN-SLACK-SANDBOX-REJECTIONS).
const context = testContext();

const SANDBOX_USER = "user_slack_sandbox";

describe("slack sandbox message/upload rejections (API-first BDD)", () => {
  it("message rejects unauthenticated callers and sandbox tokens without slack:write", async () => {
    const api = createBddApi(context);
    const body = { channel: "C123", text: "hello" };

    await accept(api.slackMessage.sendMessage({ body, headers: {} }), [401]);

    const forbidden = await accept(
      api.slackMessage.sendMessage({
        body,
        headers: api.sandboxAuth(SANDBOX_USER),
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("slack:write");
  });

  it("upload init rejects unauthenticated callers and sandbox tokens without slack:write", async () => {
    const api = createBddApi(context);
    const body = { filename: "report.pdf", length: 100 };

    await accept(api.slackUploadInit.init({ body, headers: {} }), [401]);

    const forbidden = await accept(
      api.slackUploadInit.init({
        body,
        headers: api.sandboxAuth(SANDBOX_USER),
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("slack:write");
  });

  it("upload complete rejects unauthenticated callers and sandbox tokens without slack:write", async () => {
    const api = createBddApi(context);
    const body = { fileId: "F123", channel: "C123" };

    await accept(
      api.slackUploadComplete.complete({ body, headers: {} }),
      [401],
    );

    const forbidden = await accept(
      api.slackUploadComplete.complete({
        body,
        headers: api.sandboxAuth(SANDBOX_USER),
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("slack:write");
  });
});
