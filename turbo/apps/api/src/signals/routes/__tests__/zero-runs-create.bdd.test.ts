import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the pre-admission rejections of run creation
// (`POST /api/zero/runs`). The funded happy path and every downstream run
// operation (status, cancel, queue, telemetry) require credits granted to the
// org/member, which only billing/redeem webhooks provide — there is no public
// API to fund a test org — so those stay in the kept legacy
// (`zero-runs-create.test.ts`, GAP-RUN-CREDITS). Everything here is reachable
// because it is rejected before the credit check. See `api.bdd.md`
// (CHAIN-RUN-CREATE-REJECTIONS).
const context = testContext();

describe("run create rejections (API-first BDD)", () => {
  it("rejects unauthenticated and capability-less tokens", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    const unauth = await accept(
      api.zeroRuns.create({
        headers: {},
        body: { prompt: "hello", agentId: randomUUID() },
      }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // A zero token without agent-run:write is forbidden.
    const zero = await accept(
      api.zeroRuns.create({
        headers: api.zeroAuth([]),
        body: { prompt: "hello", agentId: randomUUID() },
      }),
      [403],
    );
    expect(zero.body.error.message).toContain(
      "Missing required capability: agent-run:write",
    );

    // A plain sandbox token is forbidden the same way.
    const sandbox = await accept(
      api.zeroRuns.create({
        headers: api.sandboxAuth(`user_${randomUUID()}`),
        body: { prompt: "hello", agentId: randomUUID() },
      }),
      [403],
    );
    expect(sandbox.body.error.message).toContain(
      "Missing required capability: agent-run:write",
    );
  });

  it("validates the request body before doing any work", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // Neither agentId nor sessionId.
    const noAgent = await accept(
      api.zeroRuns.create({
        headers: SESSION_AUTH,
        body: { prompt: "hello" },
      }),
      [400],
    );
    expect(noAgent.body.error.message).toBe("agentId is required");

    // Caller-provided permission policies are rejected.
    const policies = await accept(
      api.zeroRuns.create({
        headers: SESSION_AUTH,
        body: {
          prompt: "hello",
          agentId: randomUUID(),
          permissionPolicies: { x: { policies: { "tweet.write": "allow" } } },
        } as never,
      }),
      [400],
    );
    expect(policies.body.error.code).toBe("BAD_REQUEST");
    expect(policies.body.error.message).toContain("permissionPolicies");

    // Ambiguous Claude tool entries are rejected.
    for (const tools of [[""], ["   "], ["Bash,Read"], ["--help"], [" -x"]]) {
      const response = await accept(
        api.zeroRuns.create({
          headers: SESSION_AUTH,
          body: { prompt: "hello", agentId: randomUUID(), tools },
        }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
      expect(response.body.error.message).toContain("Claude tool name");
    }

    // A sessionId that resolves to no session is not found.
    const noSession = await accept(
      api.zeroRuns.create({
        headers: SESSION_AUTH,
        body: { prompt: "hello", sessionId: randomUUID() },
      }),
      [404],
    );
    expect(noSession.body.error.message).toBe("Session not found");
  });

  it("rejects a VM0 run when the org has no credits", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    const agent = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Runner" },
      }),
      [201],
    );

    const response = await accept(
      api.zeroRuns.create({
        headers: SESSION_AUTH,
        body: {
          prompt: "vm0 credits gate",
          agentId: agent.body.agentId,
          modelProvider: "vm0",
        },
      }),
      [402],
    );
    expect(response.body.error.code).toBe("INSUFFICIENT_CREDITS");
  });

  it("prevents a non-owner from running a private agent", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const orgId = `org_${randomUUID()}`;

    // The owner creates a private agent.
    api.actAsAdmin({ orgId });
    const privateAgent = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Secret", visibility: "private" },
      }),
      [201],
    );

    // Another member of the same org cannot run it.
    api.actAsMember({ userId: `user_${randomUUID()}`, orgId });
    const response = await accept(
      api.zeroRuns.create({
        headers: SESSION_AUTH,
        body: { prompt: "hello", agentId: privateAgent.body.agentId },
      }),
      [403],
    );
    expect(response.body.error.message).toBe(
      "Only the private agent owner can run this agent",
    );
  });
});
