import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the single run-log detail auth, capability and
// not-found cases. The 200 detail variants (owner / displayName / status /
// schedule-linked / deleted-compose) need a funded run that emits logs
// (GAP-RUN-CREDITS), the other-user 404 needs a seeded foreign run, and the
// invalid-UUID 400 is a status the `logsByIdContract` does not declare (the
// ts-rest client throws on it, so it needs the raw-fetch helper). Those stay in
// the kept legacy. See `api.bdd.md` (CHAIN-LOGS-BY-ID-REJECTIONS).
const context = testContext();

describe("run-log detail rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less / capability-less callers and 404s an unknown run id", async () => {
    const api = createBddApi(context);
    const id = "00000000-0000-4000-8000-000000000001";

    // Unauthenticated.
    await accept(api.logsById.getById({ headers: {}, params: { id } }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.logsById.getById({ headers: SESSION_AUTH, params: { id } }),
      [401],
    );

    // A zero token without agent-run:read is forbidden before any run lookup.
    const forbidden = await accept(
      api.logsById.getById({
        headers: api.zeroAuth(["file:read"]),
        params: { id },
      }),
      [403],
    );
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    });

    // A valid session with no such run gets a 404.
    api.actAsAdmin();
    const notFound = await accept(
      api.logsById.getById({ headers: SESSION_AUTH, params: { id } }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Log not found", code: "NOT_FOUND" },
    });
  });
});
