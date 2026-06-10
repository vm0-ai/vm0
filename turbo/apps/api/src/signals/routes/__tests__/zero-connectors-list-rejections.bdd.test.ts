import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the connector list auth + empty-org cases. A
// populated list (and the skip-unknown-oauth-type filtering) needs connected
// connector rows from the OAuth/manual connect flow (GAP-CONNECTOR-CONNECT) and
// stays in the kept legacy. See `api.bdd.md` (CHAIN-CONNECTORS-LIST-REJECTIONS).
const context = testContext();

describe("connector list rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and returns an empty list for a fresh org", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.connectorsList.list({ headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(api.connectorsList.list({ headers: SESSION_AUTH }), [401]);

    // A fresh org has no configured connectors.
    api.actAsAdmin();
    const empty = await accept(
      api.connectorsList.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.connectors).toStrictEqual([]);
    expect(Array.isArray(empty.body.configuredTypes)).toBeTruthy();
    expect(Array.isArray(empty.body.connectorProvidedBindings)).toBeTruthy();
  });
});
