import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the not-found / validation / auth rejections of the
// schedule enable, disable, and delete endpoints. Mutating a real schedule needs
// a deployed schedule registered with the external scheduler, which has no API
// surface to create (GAP-SCHEDULE-DEPLOY); those success/by-agentId/past cases
// stay in the kept legacy. See `api.bdd.md` (CHAIN-SCHEDULE-MUTATIONS).
const context = testContext();

async function createAgent(
  api: ReturnType<typeof createBddApi>,
): Promise<string> {
  const agent = await accept(
    api.agents.create({
      headers: SESSION_AUTH,
      body: { displayName: "Scheduler" },
    }),
    [201],
  );
  return agent.body.agentId;
}

describe("schedule mutations rejections (API-first BDD)", () => {
  it("enable rejects unknown schedules, invalid bodies, and unauthenticated", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();
    const agentId = await createAgent(api);

    // No such schedule for an existing agent.
    const notFound = await accept(
      api.scheduleEnable.enable({
        headers: SESSION_AUTH,
        params: { name: "non-existent" },
        body: { agentId },
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    // Missing agentId.
    const badBody = await accept(
      api.scheduleEnable.enable({
        headers: SESSION_AUTH,
        params: { name: "any" },
        body: {} as { agentId: string },
      }),
      [400],
    );
    expect(badBody.body.error.code).toBe("BAD_REQUEST");

    // Unauthenticated.
    await accept(
      api.scheduleEnable.enable({
        headers: {},
        params: { name: "any" },
        body: { agentId: randomUUID() },
      }),
      [401],
    );
  });

  it("disable rejects unknown schedules, invalid bodies, and unauthenticated", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();
    const agentId = await createAgent(api);

    const notFound = await accept(
      api.scheduleEnable.disable({
        headers: SESSION_AUTH,
        params: { name: "non-existent" },
        body: { agentId },
      }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: "Resource not found", code: "NOT_FOUND" },
    });

    const badBody = await accept(
      api.scheduleEnable.disable({
        headers: SESSION_AUTH,
        params: { name: "any" },
        body: {} as { agentId: string },
      }),
      [400],
    );
    expect(badBody.body.error.code).toBe("BAD_REQUEST");

    await accept(
      api.scheduleEnable.disable({
        headers: {},
        params: { name: "any" },
        body: { agentId: randomUUID() },
      }),
      [401],
    );
  });

  it("delete rejects unknown schedules, invalid queries, and unauthenticated", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();
    const agentId = await createAgent(api);

    const notFound = await accept(
      api.scheduleByName.delete({
        headers: SESSION_AUTH,
        params: { name: "non-existent" },
        query: { agentId },
      }),
      [404],
    );
    expect(notFound.body.error.code).toBe("NOT_FOUND");

    const badQuery = await accept(
      api.scheduleByName.delete({
        headers: SESSION_AUTH,
        params: { name: "any" },
        query: {} as { agentId: string },
      }),
      [400],
    );
    expect(badQuery.body.error.code).toBe("BAD_REQUEST");

    await accept(
      api.scheduleByName.delete({
        headers: {},
        params: { name: "any" },
        query: { agentId: randomUUID() },
      }),
      [401],
    );

    // A zero token without schedule:delete is forbidden before any lookup.
    const zero = await accept(
      api.scheduleByName.delete({
        headers: api.zeroAuth([]),
        params: { name: "any" },
        query: { agentId: randomUUID() },
      }),
      [403],
    );
    expect(zero.body).toStrictEqual({
      error: {
        message: "Missing required capability: schedule:delete",
        code: "FORBIDDEN",
      },
    });
  });
});
