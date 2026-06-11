import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the CLI compose metadata-update auth, no-org and
// not-found cases. Updating a real compose's metadata (and the invalid-body 400
// / cross-org 404 variants) needs a seeded compose row; those stay in the kept
// legacy. See `api.bdd.md` (CHAIN-AGENT-COMPOSES-METADATA-REJECTIONS).
const context = testContext();

const UNKNOWN_COMPOSE = "00000000-0000-4000-8000-00000000000f";

describe("agent compose metadata update rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and 404s an unknown compose", async () => {
    const api = createBddApi(context);
    const body = { displayName: "x" };

    // Unauthenticated.
    await accept(
      api.agentComposesMetadata.updateMetadata({
        params: { id: UNKNOWN_COMPOSE },
        body,
        headers: {},
      }),
      [401],
    );

    // No active organization is a bad request for this CLI endpoint.
    api.actAsNoOrg();
    await accept(
      api.agentComposesMetadata.updateMetadata({
        params: { id: UNKNOWN_COMPOSE },
        body,
        headers: SESSION_AUTH,
      }),
      [400],
    );

    // A valid session updating a compose that does not exist.
    api.actAsAdmin();
    const notFound = await accept(
      api.agentComposesMetadata.updateMetadata({
        params: { id: UNKNOWN_COMPOSE },
        body,
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
  });
});
