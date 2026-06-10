import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the Slack connect status + connect auth, empty and
// unknown-workspace cases. A successful connect (and the connected-status,
// admin/member binding, idempotency and welcome-message variants) needs a seeded
// Slack installation row from the OAuth flow (GAP-CONNECTOR-CONNECT) plus Slack
// API mocks, and the missing-field / malformed-JSON 400s need a raw request the
// ts-rest client can't send; those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-SLACK-CONNECT-REJECTIONS).
const context = testContext();

describe("slack connect status + connect rejections (API-first BDD)", () => {
  it("status rejects unauthenticated / org-less callers and reports disconnected for a fresh admin org", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.slackConnect.getStatus({ headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // No active organization.
    api.actAsNoOrg();
    await accept(api.slackConnect.getStatus({ headers: SESSION_AUTH }), [401]);

    // A fresh admin org has no Slack connection.
    api.actAsAdmin();
    const status = await accept(
      api.slackConnect.getStatus({ headers: SESSION_AUTH }),
      [200],
    );
    expect(status.body).toStrictEqual({ isConnected: false, isAdmin: true });
  });

  it("connect rejects unauthenticated callers and 404s an unknown workspace", async () => {
    const api = createBddApi(context);
    const body = { workspaceId: "T-nonexistent", slackUserId: "U-test" };

    // Unauthenticated.
    await accept(api.slackConnect.connect({ headers: {}, body }), [401]);

    // A valid admin session connecting to a workspace with no installation.
    api.actAsAdmin();
    const notFound = await accept(
      api.slackConnect.connect({ headers: SESSION_AUTH, body }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: {
        message: "Workspace not found. Please install the Slack app first.",
        code: "NOT_FOUND",
      },
    });
  });
});
