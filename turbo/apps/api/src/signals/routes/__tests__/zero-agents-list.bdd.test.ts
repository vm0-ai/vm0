import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface CreatedAgent extends Actor {
  readonly agentId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    userId: `user_${prefix}_${suffix}`,
    orgId: `org_${prefix}_${suffix}`,
  };
}

async function createAgent(args: {
  readonly owner: Actor;
  readonly displayName: string;
  readonly description?: string;
  readonly sound?: string;
}): Promise<CreatedAgent> {
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");
  context.mocks.s3.send.mockResolvedValue({});
  const response = await accept(
    agentsClient().create({
      headers: authHeaders(),
      body: {
        displayName: args.displayName,
        description: args.description,
        sound: args.sound,
      },
    }),
    [201],
  );

  return await trackAgent(
    Promise.resolve({ ...args.owner, agentId: response.body.agentId }),
  );
}

async function deleteAgent(agent: CreatedAgent): Promise<void> {
  mocks.clerk.session(agent.userId, agent.orgId, "org:admin");
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      headers: authHeaders(),
      params: { id: agent.agentId },
    }),
    [204, 404],
  );
}

const trackAgent = createFixtureTracker<CreatedAgent>(deleteAgent);

describe("/api/zero/agents list BDD", () => {
  it("requires authentication and an active organization", async () => {
    const client = agentsClient();

    const unauthenticated = await accept(client.list({ headers: {} }), [401]);

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(client.list({ headers: authHeaders() }), [401]);

    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("lists route-created agents and scopes results to the caller's organization", async () => {
    const owner = actor("owner");
    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");

    const empty = await accept(
      agentsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(empty.body).toStrictEqual([]);

    const listedAgent = await createAgent({
      owner,
      displayName: "Listed Agent",
      description: "desc",
      sound: "friendly",
    });
    const otherOwner = actor("other");
    const otherAgent = await createAgent({
      owner: otherOwner,
      displayName: "Foreign Agent",
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const ownerList = await accept(
      agentsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(ownerList.body).toHaveLength(1);
    expect(ownerList.body[0]).toMatchObject({
      agentId: listedAgent.agentId,
      ownerId: owner.userId,
      displayName: "Listed Agent",
      description: "desc",
      sound: "friendly",
    });
    expect(
      ownerList.body.map((agent) => {
        return agent.agentId;
      }),
    ).not.toContain(otherAgent.agentId);

    mocks.clerk.session(otherOwner.userId, otherOwner.orgId, "org:admin");
    const otherList = await accept(
      agentsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(otherList.body).toHaveLength(1);
    expect(otherList.body[0]?.agentId).toBe(otherAgent.agentId);
  });
});
