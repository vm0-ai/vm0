import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the connector-by-type delete + scope-diff
// rejections. An org with no connector of the requested type 404s either way.
// The funded cases (deleting a connected connector, diffing stored vs current
// scopes) need a seeded connector row from the connect flow
// (GAP-CONNECTOR-CONNECT) and stay in the kept legacy. See `api.bdd.md`
// (CHAIN-CONNECTOR-BY-TYPE-MUTATIONS-REJECTIONS).
const context = testContext();

describe("connector by type delete/scope-diff rejections (API-first BDD)", () => {
  it("delete rejects unauthenticated / org-less callers and 404s an unconnected type", async () => {
    const api = createBddApi(context);

    await accept(
      api.connectorByType.delete({ params: { type: "github" }, headers: {} }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.connectorByType.delete({
        params: { type: "github" },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    api.actAsAdmin();
    const notFound = await accept(
      api.connectorByType.delete({
        params: { type: "github" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });

  it("scope-diff rejects unauthenticated / org-less / capability-less callers and 404s an unconnected type", async () => {
    const api = createBddApi(context);

    await accept(
      api.connectorScopeDiff.getScopeDiff({
        params: { type: "github" },
        headers: {},
      }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.connectorScopeDiff.getScopeDiff({
        params: { type: "github" },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    // A zero token without connector:read is forbidden.
    const zero = await accept(
      api.connectorScopeDiff.getScopeDiff({
        params: { type: "github" },
        headers: api.zeroAuth([]),
      }),
      [403],
    );
    expect(zero.body.error.message).toBe(
      "Missing required capability: connector:read",
    );

    // No connector configured for the type.
    api.actAsAdmin();
    await accept(
      api.connectorScopeDiff.getScopeDiff({
        params: { type: "github" },
        headers: SESSION_AUTH,
      }),
      [404],
    );
  });
});
