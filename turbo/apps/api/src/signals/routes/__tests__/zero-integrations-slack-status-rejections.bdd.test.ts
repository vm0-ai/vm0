import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the org Slack status auth + not-installed cases. A
// fresh admin org reports `isInstalled: false` / `isConnected: false` /
// `isAdmin: true`. The OAuth install/connect URL contents need the Slack client
// env the legacy harness configures, and the connected-workspace,
// isConnected=false (installation present, no user connection), environment-detail
// and scope-mismatch variants need a seeded installation / connection / default
// agent version (GAP-CONNECTOR-CONNECT); those stay in the kept legacy. See
// `api.bdd.md` (CHAIN-SLACK-STATUS-REJECTIONS).
const context = testContext();

describe("org slack status rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and reports not-installed for a fresh admin org", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.slackIntegration.getStatus({ headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.slackIntegration.getStatus({ headers: SESSION_AUTH }),
      [401],
    );

    // A fresh admin org has no Slack installation or connection.
    api.actAsAdmin();
    const status = await accept(
      api.slackIntegration.getStatus({ headers: SESSION_AUTH }),
      [200],
    );
    expect(status.body.isConnected).toBeFalsy();
    expect(status.body.isInstalled).toBeFalsy();
    expect(status.body.isAdmin).toBeTruthy();
  });
});
