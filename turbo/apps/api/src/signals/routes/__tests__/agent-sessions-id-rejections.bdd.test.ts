import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the session get-by-id auth and not-found cases.
// Reading a real session needs a funded run that produced it (GAP-RUN-CREDITS),
// and the other-user 403 / other-org 404 variants need a seeded foreign session;
// those stay in the kept legacy. See `api.bdd.md`
// (CHAIN-AGENT-SESSIONS-ID-REJECTIONS).
const context = testContext();

const UNKNOWN_SESSION = "00000000-0000-4000-8000-00000000000b";

describe("agent session get-by-id rejections (API-first BDD)", () => {
  it("rejects unauthenticated callers and 404s org-less callers + unknown sessions", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.sessionsById.getById({
        params: { id: UNKNOWN_SESSION },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // No active organization resolves no session.
    api.actAsNoOrg();
    const noOrg = await accept(
      api.sessionsById.getById({
        params: { id: UNKNOWN_SESSION },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });

    // A valid session reading a session that does not exist.
    api.actAsAdmin();
    const notFound = await accept(
      api.sessionsById.getById({
        params: { id: UNKNOWN_SESSION },
        headers: SESSION_AUTH,
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });
  });
});
