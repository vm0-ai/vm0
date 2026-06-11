import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the org default-agent set auth, admin-only and
// not-found cases. Setting a real default agent (and clearing it, the
// cross-org-isolation 404, the current-default GET) needs a seeded compose and
// stays in the kept legacy. See `api.bdd.md` (CHAIN-DEFAULT-AGENT-REJECTIONS).
const context = testContext();

const UNKNOWN_AGENT = "00000000-0000-4000-8000-000000000010";

describe("org default agent rejections (API-first BDD)", () => {
  it("set rejects unauthenticated / org-less / non-admin callers and 404s an unknown agent", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.orgDefaultAgent.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: {},
      }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.orgDefaultAgent.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    // A non-admin member cannot set the default agent (checked before lookup).
    api.actAsMember({ userId: "user_da_member", orgId: "org_da" });
    const forbidden = await accept(
      api.orgDefaultAgent.setDefaultAgent({
        query: {},
        body: { agentId: UNKNOWN_AGENT },
        headers: SESSION_AUTH,
      }),
      [403],
    );
    expect(forbidden.body.error.message).toBe(
      "Only org admins can set the default agent",
    );

    // An admin pointing at an agent that does not exist in the org.
    api.actAsAdmin();
    const notFound = await accept(
      api.orgDefaultAgent.setDefaultAgent({
        query: {},
        body: { agentId: UNKNOWN_AGENT },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body.error.message).toBe("Agent not found in this org");
  });
});
