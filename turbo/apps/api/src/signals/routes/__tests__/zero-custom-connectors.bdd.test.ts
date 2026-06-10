import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";

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

interface CreatedConnector extends Actor {
  readonly connectorId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function connectorsClient() {
  return setupApp({ context })(zeroCustomConnectorsContract);
}

function connectorByIdClient() {
  return setupApp({ context })(zeroCustomConnectorByIdContract);
}

function connectorSecretClient() {
  return setupApp({ context })(zeroCustomConnectorSecretContract);
}

function actor(prefix: string): Actor {
  return {
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

function connectorBody(
  values: Partial<CreateCustomConnectorBody> = {},
): CreateCustomConnectorBody {
  return {
    displayName: values.displayName ?? "Example",
    prefixes: values.prefixes ?? ["https://api.example.com/"],
    headerName: values.headerName ?? "Authorization",
    headerTemplate: values.headerTemplate ?? "Bearer {{secret}}",
    ...(values.slug !== undefined ? { slug: values.slug } : {}),
  };
}

async function createConnector(args: {
  readonly owner: Actor;
  readonly body?: Partial<CreateCustomConnectorBody>;
}): Promise<CustomConnectorResponse> {
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");
  const response = await accept(
    connectorsClient().create({
      headers: authHeaders(),
      body: connectorBody(args.body),
    }),
    [201],
  );
  await trackConnector(
    Promise.resolve({
      ...args.owner,
      connectorId: response.body.id,
    }),
  );
  return response.body;
}

async function deleteConnector(connector: CreatedConnector): Promise<void> {
  mocks.clerk.session(connector.userId, connector.orgId, "org:admin");
  await accept(
    connectorByIdClient().delete({
      headers: authHeaders(),
      params: { id: connector.connectorId },
    }),
    [204, 404],
  );
}

const trackConnector = createFixtureTracker<CreatedConnector>(deleteConnector);

async function listConnectors(
  viewer: Actor,
  role: "org:admin" | "org:member" = "org:admin",
): Promise<readonly CustomConnectorResponse[]> {
  mocks.clerk.session(viewer.userId, viewer.orgId, role);
  const response = await accept(
    connectorsClient().list({ headers: authHeaders() }),
    [200],
  );
  return response.body.connectors;
}

function findConnector(
  connectors: readonly CustomConnectorResponse[],
  connectorId: string,
): CustomConnectorResponse | undefined {
  return connectors.find((connector) => {
    return connector.id === connectorId;
  });
}

async function expectListedConnector(args: {
  readonly viewer: Actor;
  readonly connectorId: string;
  readonly hasSecret?: boolean;
  readonly displayName?: string;
  readonly role?: "org:admin" | "org:member";
}): Promise<CustomConnectorResponse> {
  const connectors = await listConnectors(args.viewer, args.role);
  const connector = findConnector(connectors, args.connectorId);
  expect(connector).toBeDefined();
  if (!connector) {
    throw new Error("Expected connector to be listed");
  }
  if (args.hasSecret !== undefined) {
    expect(connector.hasSecret).toBe(args.hasSecret);
  }
  if (args.displayName !== undefined) {
    expect(connector.displayName).toBe(args.displayName);
  }
  return connector;
}

async function expectConnectorHidden(args: {
  readonly viewer: Actor;
  readonly connectorId: string;
  readonly role?: "org:admin" | "org:member";
}): Promise<void> {
  const connectors = await listConnectors(args.viewer, args.role);
  expect(findConnector(connectors, args.connectorId)).toBeUndefined();
}

async function setSecret(args: {
  readonly actor: Actor;
  readonly connectorId: string;
  readonly value: string;
  readonly role?: "org:admin" | "org:member";
}): Promise<void> {
  mocks.clerk.session(args.actor.userId, args.actor.orgId, args.role);
  const response = await accept(
    connectorSecretClient().set({
      headers: authHeaders(),
      params: { id: args.connectorId },
      body: { value: args.value },
    }),
    [204],
  );
  expect(response.body).toBeUndefined();
}

describe("/api/zero/custom-connectors BDD", () => {
  it("requires authentication and an active organization, and lists an empty org", async () => {
    const client = connectorsClient();

    const unauthenticated = await accept(client.list({ headers: {} }), [401]);

    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    mocks.clerk.session(`user_no_org_${randomUUID().slice(0, 8)}`, null);
    const noOrg = await accept(client.list({ headers: authHeaders() }), [401]);

    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const empty = actor("zcc_empty");
    const emptyList = await listConnectors(empty);

    expect(emptyList).toStrictEqual([]);
  });

  it("creates connectors, lists only the caller's org, and rejects invalid create requests", async () => {
    const owner = actor("zcc_create");
    const otherOrg = actor("zcc_create_other");
    const client = connectorsClient();

    const createUnauthenticated = await accept(
      client.create({ headers: {}, body: connectorBody() }),
      [401],
    );
    expect(createUnauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(owner.userId, owner.orgId, "org:member");
    const nonAdmin = await accept(
      client.create({ headers: authHeaders(), body: connectorBody() }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can create custom connectors",
        code: "FORBIDDEN",
      },
    });

    const created = await createConnector({ owner });
    expect(created.slug).toMatch(/^api-example-com-/);
    expect(created.displayName).toBe("Example");
    expect(created.prefixes).toStrictEqual(["https://api.example.com/"]);
    expect(created.hasSecret).toBeFalsy();

    const ownerList = await listConnectors(owner);
    expect(ownerList).toStrictEqual([created]);

    const otherOrgList = await listConnectors(otherOrg);
    expect(otherOrgList).toStrictEqual([]);

    const normalized = await createConnector({
      owner,
      body: {
        displayName: "Normalized",
        prefixes: ["https://api.example.com/v1"],
      },
    });
    expect(normalized.prefixes).toStrictEqual(["https://api.example.com/v1/"]);

    const wildcard = await createConnector({
      owner,
      body: {
        displayName: "Wildcard",
        prefixes: ["https://*.example.com/v1"],
      },
    });
    expect(wildcard.slug).toMatch(/^example-com-/);
    expect(wildcard.prefixes).toStrictEqual(["https://*.example.com/v1/"]);

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const missingSecretPlaceholder = await accept(
      client.create({
        headers: authHeaders(),
        body: connectorBody({ headerTemplate: "Bearer static-token" }),
      }),
      [400],
    );
    const nonHttpsPrefix = await accept(
      client.create({
        headers: authHeaders(),
        body: connectorBody({ prefixes: ["http://api.example.com/"] }),
      }),
      [400],
    );
    const builtInHost = await accept(
      client.create({
        headers: authHeaders(),
        body: connectorBody({
          displayName: "Fake GitHub",
          prefixes: ["https://api.github.com/v3/"],
        }),
      }),
      [400],
    );

    expect(missingSecretPlaceholder.body.error.message).toContain("{{secret}}");
    expect(nonHttpsPrefix.body.error.message).toContain("https");
    expect(builtInHost.body.error.message).toContain("api.github.com");
    expect(builtInHost.body.error.message).toContain("GitHub");
  });

  it("renames connectors through the API and does not leak cross-org existence", async () => {
    const owner = actor("zcc_patch");
    const member = {
      ...owner,
      userId: `user_zcc_patch_member_${randomUUID()}`,
    };
    const otherOrg = actor("zcc_patch_other");
    const connector = await createConnector({
      owner,
      body: { displayName: "Original", slug: "patch-happy" },
    });
    const otherConnector = await createConnector({
      owner: otherOrg,
      body: { displayName: "OtherOrg", slug: "patch-other" },
    });
    const client = connectorByIdClient();

    mocks.clerk.session(member.userId, member.orgId, "org:member");
    const nonAdmin = await accept(
      client.patch({
        headers: authHeaders(),
        params: { id: connector.id },
        body: { displayName: "Hacked" },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can rename custom connectors",
        code: "FORBIDDEN",
      },
    });
    await expectListedConnector({
      viewer: owner,
      connectorId: connector.id,
      displayName: "Original",
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const invalidName = await accept(
      client.patch({
        headers: authHeaders(),
        params: { id: connector.id },
        body: { displayName: "" },
      }),
      [400],
    );
    expect(invalidName.body.error.code).toBe("BAD_REQUEST");
    await expectListedConnector({
      viewer: owner,
      connectorId: connector.id,
      displayName: "Original",
    });

    const unknown = await accept(
      client.patch({
        headers: authHeaders(),
        params: { id: randomUUID() },
        body: { displayName: "Missing" },
      }),
      [404],
    );
    const crossOrg = await accept(
      client.patch({
        headers: authHeaders(),
        params: { id: otherConnector.id },
        body: { displayName: "Hijacked" },
      }),
      [404],
    );
    expect(unknown.body.error.code).toBe("NOT_FOUND");
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");
    await expectListedConnector({
      viewer: otherOrg,
      connectorId: otherConnector.id,
      displayName: "OtherOrg",
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const renamed = await accept(
      client.patch({
        headers: authHeaders(),
        params: { id: connector.id },
        body: { displayName: "Renamed" },
      }),
      [200],
    );

    expect(renamed.body.id).toBe(connector.id);
    expect(renamed.body.slug).toBe("patch-happy");
    expect(renamed.body.displayName).toBe("Renamed");
    await expectListedConnector({
      viewer: owner,
      connectorId: connector.id,
      displayName: "Renamed",
    });
  });

  it("sets and clears per-user secrets without leaking across users", async () => {
    const owner = actor("zcc_secret");
    const member = {
      ...owner,
      userId: `user_zcc_secret_member_${randomUUID().slice(0, 8)}`,
    };
    const connector = await createConnector({ owner });
    const client = connectorSecretClient();

    await expectListedConnector({
      viewer: owner,
      connectorId: connector.id,
      hasSecret: false,
    });

    mocks.clerk.session(`user_zcc_secret_no_org_${randomUUID()}`, null);
    const noOrgSet = await accept(
      client.set({
        headers: authHeaders(),
        params: { id: connector.id },
        body: { value: "x" },
      }),
      [401],
    );
    expect(noOrgSet.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const unknownSet = await accept(
      client.set({
        headers: authHeaders(),
        params: { id: randomUUID() },
        body: { value: "x" },
      }),
      [404],
    );
    expect(unknownSet.body.error.code).toBe("NOT_FOUND");

    await setSecret({
      actor: owner,
      connectorId: connector.id,
      value: "sk_live_owner",
    });
    await expectListedConnector({
      viewer: owner,
      connectorId: connector.id,
      hasSecret: true,
    });
    await expectListedConnector({
      viewer: member,
      connectorId: connector.id,
      role: "org:member",
      hasSecret: false,
    });

    await setSecret({
      actor: member,
      connectorId: connector.id,
      role: "org:member",
      value: "sk_live_member",
    });
    await expectListedConnector({
      viewer: member,
      connectorId: connector.id,
      role: "org:member",
      hasSecret: true,
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const firstDelete = await accept(
      client.delete({
        headers: authHeaders(),
        params: { id: connector.id },
      }),
      [204],
    );
    const secondDelete = await accept(
      client.delete({
        headers: authHeaders(),
        params: { id: connector.id },
      }),
      [204],
    );

    expect(firstDelete.body).toBeUndefined();
    expect(secondDelete.body).toBeUndefined();
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
    await expectListedConnector({
      viewer: owner,
      connectorId: connector.id,
      hasSecret: false,
    });
    await expectListedConnector({
      viewer: member,
      connectorId: connector.id,
      role: "org:member",
      hasSecret: true,
    });
  });

  it("deletes connectors through the API and hides them from every org-visible list", async () => {
    const owner = actor("zcc_delete");
    const member = {
      ...owner,
      userId: `user_zcc_delete_member_${randomUUID().slice(0, 8)}`,
    };
    const otherOrg = actor("zcc_delete_other");
    const connector = await createConnector({ owner });
    const otherConnector = await createConnector({ owner: otherOrg });
    const client = connectorByIdClient();

    await setSecret({
      actor: owner,
      connectorId: connector.id,
      value: "owner-token",
    });
    await setSecret({
      actor: member,
      connectorId: connector.id,
      role: "org:member",
      value: "member-token",
    });

    mocks.clerk.session(member.userId, member.orgId, "org:member");
    const nonAdmin = await accept(
      client.delete({
        headers: authHeaders(),
        params: { id: connector.id },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can delete custom connectors",
        code: "FORBIDDEN",
      },
    });
    await expectListedConnector({
      viewer: owner,
      connectorId: connector.id,
      hasSecret: true,
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const crossOrg = await accept(
      client.delete({
        headers: authHeaders(),
        params: { id: otherConnector.id },
      }),
      [404],
    );
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");
    await expectListedConnector({
      viewer: otherOrg,
      connectorId: otherConnector.id,
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const deleted = await accept(
      client.delete({
        headers: authHeaders(),
        params: { id: connector.id },
      }),
      [204],
    );
    expect(deleted.body).toBeUndefined();

    await expectConnectorHidden({ viewer: owner, connectorId: connector.id });
    await expectConnectorHidden({
      viewer: member,
      connectorId: connector.id,
      role: "org:member",
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const repeatDelete = await accept(
      client.delete({
        headers: authHeaders(),
        params: { id: connector.id },
      }),
      [404],
    );
    expect(repeatDelete.body.error.code).toBe("NOT_FOUND");
  });
});
