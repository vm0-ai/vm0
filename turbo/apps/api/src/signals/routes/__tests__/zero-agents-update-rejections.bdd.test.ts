import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the agent update (PUT), metadata update (PATCH) and
// instructions update auth, capability, invalid-id and not-found rejections.
// The success paths (recompose, skill/model validation, visibility/public-limit
// rules, ownership variants, instructions storage) update a real agent and stay
// in the kept legacy. See `api.bdd.md` (CHAIN-AGENT-UPDATE-REJECTIONS).
const context = testContext();

const UNKNOWN_AGENT = "00000000-0000-4000-8000-000000000005";

describe("agent update / metadata / instructions rejections (API-first BDD)", () => {
  it("update (PUT) rejects unauthenticated / capability-less / invalid-id / unknown-agent callers", async () => {
    const api = createBddApi(context);

    await accept(
      api.agentsById.update({
        params: { id: UNKNOWN_AGENT },
        headers: {},
        body: {},
      }),
      [401],
    );

    const forbidden = await accept(
      api.agentsById.update({
        params: { id: UNKNOWN_AGENT },
        headers: api.zeroAuth(["agent:read"]),
        body: {},
      }),
      [403],
    );
    expect(forbidden.body.error.message).toBe(
      "Missing required capability: agent:write",
    );

    api.actAsAdmin();
    await accept(
      api.agentsById.update({
        params: { id: "not-a-uuid" },
        headers: SESSION_AUTH,
        body: {},
      }),
      [400],
    );

    const notFound = await accept(
      api.agentsById.update({
        params: { id: UNKNOWN_AGENT },
        headers: SESSION_AUTH,
        body: {},
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: {
        message: `Agent not found: ${UNKNOWN_AGENT}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("metadata update (PATCH) rejects unauthenticated / capability-less / invalid-id / unknown-agent callers", async () => {
    const api = createBddApi(context);

    await accept(
      api.agentsById.updateMetadata({
        params: { id: UNKNOWN_AGENT },
        headers: {},
        body: {},
      }),
      [401],
    );

    await accept(
      api.agentsById.updateMetadata({
        params: { id: UNKNOWN_AGENT },
        headers: api.zeroAuth(["agent:read"]),
        body: {},
      }),
      [403],
    );

    api.actAsAdmin();
    await accept(
      api.agentsById.updateMetadata({
        params: { id: "not-a-uuid" },
        headers: SESSION_AUTH,
        body: {},
      }),
      [400],
    );

    const notFound = await accept(
      api.agentsById.updateMetadata({
        params: { id: UNKNOWN_AGENT },
        headers: SESSION_AUTH,
        body: {},
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");
  });

  it("instructions update rejects unauthenticated / capability-less / invalid-id / unknown-agent callers", async () => {
    const api = createBddApi(context);
    const body = { content: "new instructions" };

    await accept(
      api.agentInstructions.update({
        params: { id: UNKNOWN_AGENT },
        headers: {},
        body,
      }),
      [401],
    );

    const forbidden = await accept(
      api.agentInstructions.update({
        params: { id: UNKNOWN_AGENT },
        headers: api.zeroAuth(["agent:read"]),
        body,
      }),
      [403],
    );
    expect(forbidden.body.error.message).toBe(
      "Missing required capability: agent:write",
    );

    api.actAsAdmin();
    await accept(
      api.agentInstructions.update({
        params: { id: "not-a-uuid" },
        headers: SESSION_AUTH,
        body,
      }),
      [400],
    );

    const notFound = await accept(
      api.agentInstructions.update({
        params: { id: UNKNOWN_AGENT },
        headers: SESSION_AUTH,
        body,
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: {
        message: `Agent not found: ${UNKNOWN_AGENT}`,
        code: "NOT_FOUND",
      },
    });
  });
});
