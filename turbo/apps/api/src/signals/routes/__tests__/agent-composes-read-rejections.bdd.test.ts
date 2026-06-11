import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the CLI-facing compose get-by-name + list auth,
// no-org and empty-list cases. Reading a named compose / a populated list, and
// the missing-name / malformed-id 400s (which need a raw request the ts-rest
// client can't send), need seeded compose rows and stay in the kept legacy. See
// `api.bdd.md` (CHAIN-AGENT-COMPOSES-READ-REJECTIONS).
const context = testContext();

describe("agent composes read rejections (API-first BDD)", () => {
  it("get-by-name rejects unauthenticated callers", async () => {
    const api = createBddApi(context);
    const unauth = await accept(
      api.agentComposesMain.getByName({
        query: { name: "missing" },
        headers: {},
      }),
      [401],
    );
    expect(unauth.body.error.message).toBe("Not authenticated");
  });

  it("list rejects unauthenticated / org-less callers and is empty for a fresh org", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.agentComposesList.list({ query: {}, headers: {} }),
      [401],
    );
    expect(unauth.body.error.message).toBe("Not authenticated");

    // No active organization is a bad request for this CLI endpoint.
    api.actAsNoOrg();
    const noOrg = await accept(
      api.agentComposesList.list({ query: {}, headers: SESSION_AUTH }),
      [400],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });

    // A fresh org has no composes.
    api.actAsAdmin();
    const empty = await accept(
      api.agentComposesList.list({ query: {}, headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ composes: [] });
  });
});
