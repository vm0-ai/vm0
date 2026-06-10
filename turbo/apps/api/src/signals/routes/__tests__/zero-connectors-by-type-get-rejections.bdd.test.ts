import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for reading a connector by type when none is connected.
// An org with no connector of the requested type gets a 404. A connected
// connector (and the legacy-secret variants) need the OAuth/manual connect flow
// to seed a connector row (GAP-CONNECTOR-CONNECT) and stay in the kept legacy.
// See `api.bdd.md` (CHAIN-CONNECTOR-BY-TYPE-REJECTIONS).
const context = testContext();

describe("connector by type read rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less reads and 404s an unconnected type", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.connectorByType.get({ params: { type: "github" }, headers: {} }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.connectorByType.get({
        params: { type: "github" },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    // No connector of that type for the org.
    api.actAsAdmin();
    const notFound = await accept(
      api.connectorByType.get({
        params: { type: "github" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
  });
});
