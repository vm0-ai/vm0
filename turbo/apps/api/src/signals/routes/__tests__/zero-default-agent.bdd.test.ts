import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { orgDefaultAgentContract } from "@vm0/api-contracts/contracts/orgs";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { createApp } from "../../../app-factory";
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

function defaultAgentClient() {
  return setupApp({ context })(orgDefaultAgentContract);
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function actor(): Actor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

async function createAgent(args: {
  readonly actor: Actor;
  readonly displayName: string;
}): Promise<CreatedAgent> {
  mocks.clerk.session(args.actor.userId, args.actor.orgId);
  const response = await accept(
    agentsClient().create({
      headers: authHeaders(),
      body: { displayName: args.displayName },
    }),
    [201],
  );

  const agent = { ...args.actor, agentId: response.body.agentId };
  return await trackAgent(Promise.resolve(agent));
}

async function deleteAgent(agent: CreatedAgent): Promise<void> {
  mocks.clerk.session(agent.userId, agent.orgId);
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

async function invalidBodyRequest(actorRef: Actor): Promise<Response> {
  mocks.clerk.session(actorRef.userId, actorRef.orgId, "org:admin");
  const app = createApp({ signal: context.signal });
  return await app.request("/api/zero/default-agent", {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
}

describe("/api/zero/default-agent BDD", () => {
  it("requires authentication, an active organization, an admin caller, and a valid body", async () => {
    const client = defaultAgentClient();

    const unauthenticated = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    const member = actor();
    mocks.clerk.session(member.userId, member.orgId, "org:member");
    const nonAdmin = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: randomUUID() },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can set the default agent",
        code: "FORBIDDEN",
      },
    });

    const invalid = await invalidBodyRequest(actor());

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("sets a default agent, blocks duplicate and unset writes, and enforces org isolation", async () => {
    const owner = actor();
    const other = actor();
    const ownerAgent = await createAgent({
      actor: owner,
      displayName: "default-agent",
    });
    const otherAgent = await createAgent({
      actor: other,
      displayName: "other-org-agent",
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    const client = defaultAgentClient();

    const missing = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: "00000000-0000-0000-0000-000000000000" },
        headers: authHeaders(),
      }),
      [404],
    );
    const crossOrg = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: otherAgent.agentId },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missing.body).toMatchObject({
      error: {
        message: "Agent not found in this org",
        code: "NOT_FOUND",
      },
    });
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    const set = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: ownerAgent.agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(set.body).toStrictEqual({ agentId: ownerAgent.agentId });

    const duplicate = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: ownerAgent.agentId },
        headers: authHeaders(),
      }),
      [409],
    );
    const unset = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: null },
        headers: authHeaders(),
      }),
      [409],
    );
    const stillSet = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: ownerAgent.agentId },
        headers: authHeaders(),
      }),
      [409],
    );

    expect(duplicate.body.error.code).toBe("CONFLICT");
    expect(unset.body.error.code).toBe("CONFLICT");
    expect(stillSet.body.error.code).toBe("CONFLICT");
  });

  it("allows a new default after the previous default agent is deleted", async () => {
    const owner = actor();
    const first = await createAgent({
      actor: owner,
      displayName: "first-default-agent",
    });
    mocks.clerk.session(owner.userId, owner.orgId);
    const client = defaultAgentClient();

    const firstSet = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: first.agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(firstSet.body.agentId).toBe(first.agentId);

    await deleteAgent(first);

    const second = await createAgent({
      actor: owner,
      displayName: "second-default-agent",
    });
    mocks.clerk.session(owner.userId, owner.orgId);
    const secondSet = await accept(
      client.setDefaultAgent({
        query: {},
        body: { agentId: second.agentId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(secondSet.body.agentId).toBe(second.agentId);
  });
});
