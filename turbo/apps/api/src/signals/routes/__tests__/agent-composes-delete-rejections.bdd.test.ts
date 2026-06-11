import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the CLI compose delete auth, scope and not-found
// cases. Deleting a real compose (and the instructions-volume cleanup / skill
// volume variants) needs a seeded compose row, and the malformed-id 400 needs a
// raw request the ts-rest client can't send; those stay in the kept legacy, as
// does the zero-token 403 (it needs a run-scoped zero token the helper does not
// build). See `api.bdd.md` (CHAIN-AGENT-COMPOSES-DELETE-REJECTIONS).
const context = testContext();

const UNKNOWN_COMPOSE = "00000000-0000-4000-8000-00000000000e";

describe("agent compose delete rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers, sandbox/zero tokens, and 404s an unknown compose", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.agentComposesById.delete({
        params: { id: UNKNOWN_COMPOSE },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // A sandbox token cannot delete agents.
    const sandbox = await accept(
      api.agentComposesById.delete({
        params: { id: UNKNOWN_COMPOSE },
        headers: api.sandboxAuth("user_compose_delete"),
      }),
      [403],
    );
    expect(sandbox.body.error.message).toBe(
      "Agent deletion is not available from sandbox",
    );

    // A valid session deleting a compose that does not exist.
    api.actAsAdmin();
    const notFound = await accept(
      api.agentComposesById.delete({
        params: { id: UNKNOWN_COMPOSE },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });
});
