import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the Slack channel list auth + no-installation
// cases. Listing real channels (and the empty-bot-membership case) needs a
// seeded Slack installation plus a Slack API mock (GAP-CONNECTOR-CONNECT) and
// stays in the kept legacy. See `api.bdd.md` (CHAIN-SLACK-CHANNELS-REJECTIONS).
const context = testContext();

describe("slack channel list rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and 404s an org with no installation", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(api.slackChannels.list({ headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // No active organization.
    api.actAsNoOrg();
    await accept(api.slackChannels.list({ headers: SESSION_AUTH }), [401]);

    // A fresh org has no Slack installation.
    api.actAsAdmin();
    const notFound = await accept(
      api.slackChannels.list({ headers: SESSION_AUTH }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: {
        message: "No Slack installation found for this org",
        code: "NOT_FOUND",
      },
    });
  });
});
