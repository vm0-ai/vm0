import { randomUUID } from "node:crypto";

import { GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
} from "../../services/crypto.utils";
import { fakeKmsClient } from "./helpers/fake-kms-client";
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

interface NamedUserResource {
  readonly actor: Actor;
  readonly name: string;
}

const trackVariable = createFixtureTracker<NamedUserResource>(
  async (resource) => {
    mocks.clerk.session(resource.actor.userId, resource.actor.orgId);
    await accept(
      variableByNameClient().delete({
        params: { name: resource.name },
        headers: authHeaders(),
      }),
      [204, 404],
    );
  },
);

const trackSecret = createFixtureTracker<NamedUserResource>(
  async (resource) => {
    mocks.clerk.session(resource.actor.userId, resource.actor.orgId);
    await accept(
      secretByNameClient().delete({
        params: { name: resource.name },
        headers: authHeaders(),
      }),
      [204, 404],
    );
  },
);

afterEach(() => {
  clearMockedEnv();
  resetSecretKmsClientForTests();
});

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function actor(): Actor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function token(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
}

function variableName(prefix: string): string {
  return `${prefix}_${token()}`;
}

function secretName(prefix: string): string {
  return `${prefix}_${token()}`;
}

function variablesClient() {
  return setupApp({ context })(zeroVariablesContract);
}

function variableByNameClient() {
  return setupApp({ context })(zeroVariablesByNameContract);
}

function secretsClient() {
  return setupApp({ context })(zeroSecretsContract);
}

function secretByNameClient() {
  return setupApp({ context })(zeroSecretsByNameContract);
}

async function createVariable(args: {
  readonly actor: Actor;
  readonly name: string;
  readonly value: string;
  readonly description?: string;
}): Promise<void> {
  mocks.clerk.session(args.actor.userId, args.actor.orgId);
  await accept(
    variablesClient().set({
      headers: authHeaders(),
      body: {
        name: args.name,
        value: args.value,
        description: args.description,
      },
    }),
    [200],
  );
  await trackVariable(Promise.resolve({ actor: args.actor, name: args.name }));
}

async function createSecret(args: {
  readonly actor: Actor;
  readonly name: string;
  readonly value: string;
  readonly description?: string;
}): Promise<void> {
  mocks.clerk.session(args.actor.userId, args.actor.orgId);
  await accept(
    secretsClient().set({
      headers: authHeaders(),
      body: {
        name: args.name,
        value: args.value,
        description: args.description,
      },
    }),
    [200],
  );
  await trackSecret(Promise.resolve({ actor: args.actor, name: args.name }));
}

describe("/api/zero/variables BDD", () => {
  it("requires authentication and an active organization for list, set, and delete", async () => {
    const variables = variablesClient();
    const byName = variableByNameClient();

    const unauthenticatedList = await accept(
      variables.list({ headers: {} }),
      [401],
    );
    const unauthenticatedSet = await accept(
      variables.set({
        headers: {},
        body: { name: "MY_VARIABLE", value: "variable-value" },
      }),
      [401],
    );
    const unauthenticatedDelete = await accept(
      byName.delete({ params: { name: "MY_VARIABLE" }, headers: {} }),
      [401],
    );

    expect(unauthenticatedList.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedSet.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedDelete.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrgList = await accept(
      variables.list({ headers: authHeaders() }),
      [401],
    );
    const noOrgSet = await accept(
      variables.set({
        headers: authHeaders(),
        body: { name: "MY_VARIABLE", value: "variable-value" },
      }),
      [401],
    );
    const noOrgDelete = await accept(
      byName.delete({
        params: { name: "MY_VARIABLE" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrgList.body.error.code).toBe("UNAUTHORIZED");
    expect(noOrgSet.body.error.code).toBe("UNAUTHORIZED");
    expect(noOrgDelete.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates, updates, lists, isolates, and deletes user variables", async () => {
    const owner = actor();
    const sameOrgOtherUser = {
      orgId: owner.orgId,
      userId: `user_${randomUUID()}`,
    };
    const otherOrg = actor();
    const alpha = variableName("A_VARIABLE");
    const zed = variableName("Z_VARIABLE");
    const shared = variableName("SHARED_VARIABLE");
    const otherOrgName = variableName("OTHER_ORG_VARIABLE");

    mocks.clerk.session(owner.userId, owner.orgId);
    const empty = await accept(
      variablesClient().list({ headers: authHeaders() }),
      [200],
    );
    const invalid = await accept(
      variablesClient().set({
        headers: authHeaders(),
        body: { name: "invalid name with spaces", value: "variable-value" },
      }),
      [400],
    );

    expect(empty.body).toStrictEqual({ variables: [] });
    expect(invalid.body.error.code).toBe("BAD_REQUEST");

    await createVariable({
      actor: owner,
      name: zed,
      value: "zed-v1",
    });
    await createVariable({
      actor: owner,
      name: alpha,
      value: "alpha-v1",
      description: "alpha",
    });
    await createVariable({
      actor: sameOrgOtherUser,
      name: shared,
      value: "same-org-other-user",
    });
    await createVariable({
      actor: otherOrg,
      name: otherOrgName,
      value: "other-org",
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    const listed = await accept(
      variablesClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      listed.body.variables.map((variable) => {
        return variable.name;
      }),
    ).toStrictEqual([alpha, zed]);
    expect(listed.body.variables[0]).toMatchObject({
      name: alpha,
      value: "alpha-v1",
      description: "alpha",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const updated = await accept(
      variablesClient().set({
        headers: authHeaders(),
        body: {
          name: zed,
          value: "zed-v2",
          description: "updated zed",
        },
      }),
      [200],
    );
    const afterUpdate = await accept(
      variablesClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(updated.body).toMatchObject({
      name: zed,
      value: "zed-v2",
      description: "updated zed",
    });
    expect(
      afterUpdate.body.variables.filter((variable) => {
        return variable.name === zed;
      }),
    ).toHaveLength(1);
    expect(
      afterUpdate.body.variables.find((variable) => {
        return variable.name === zed;
      }),
    ).toMatchObject({
      value: "zed-v2",
      description: "updated zed",
    });

    const crossUserDelete = await accept(
      variableByNameClient().delete({
        params: { name: shared },
        headers: authHeaders(),
      }),
      [404],
    );
    const crossOrgDelete = await accept(
      variableByNameClient().delete({
        params: { name: otherOrgName },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(crossUserDelete.body.error.code).toBe("NOT_FOUND");
    expect(crossOrgDelete.body.error.code).toBe("NOT_FOUND");

    mocks.clerk.session(sameOrgOtherUser.userId, sameOrgOtherUser.orgId);
    const sameOrgOtherUserList = await accept(
      variablesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      sameOrgOtherUserList.body.variables.map((variable) => {
        return variable.name;
      }),
    ).toStrictEqual([shared]);

    mocks.clerk.session(otherOrg.userId, otherOrg.orgId);
    const otherOrgList = await accept(
      variablesClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      otherOrgList.body.variables.map((variable) => {
        return variable.name;
      }),
    ).toStrictEqual([otherOrgName]);

    mocks.clerk.session(owner.userId, owner.orgId);
    const deleted = await variableByNameClient().delete({
      params: { name: alpha },
      headers: authHeaders(),
    });
    const deleteAgain = await accept(
      variableByNameClient().delete({
        params: { name: alpha },
        headers: authHeaders(),
      }),
      [404],
    );
    const afterDelete = await accept(
      variablesClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(deleted.status).toBe(204);
    expect(deleteAgain.body).toStrictEqual({
      error: { message: `Variable "${alpha}" not found`, code: "NOT_FOUND" },
    });
    expect(
      afterDelete.body.variables.map((variable) => {
        return variable.name;
      }),
    ).toStrictEqual([zed]);
  });
});

describe("/api/zero/secrets BDD", () => {
  it("requires authentication and an active organization for list, set, and delete", async () => {
    const secrets = secretsClient();
    const byName = secretByNameClient();

    const unauthenticatedList = await accept(
      secrets.list({ headers: {} }),
      [401],
    );
    const unauthenticatedSet = await accept(
      secrets.set({
        headers: {},
        body: { name: "MY_SECRET", value: "secret-value" },
      }),
      [401],
    );
    const unauthenticatedDelete = await accept(
      byName.delete({ params: { name: "MY_SECRET" }, headers: {} }),
      [401],
    );

    expect(unauthenticatedList.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedSet.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedDelete.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrgList = await accept(
      secrets.list({ headers: authHeaders() }),
      [401],
    );
    const noOrgSet = await accept(
      secrets.set({
        headers: authHeaders(),
        body: { name: "MY_SECRET", value: "secret-value" },
      }),
      [401],
    );
    const noOrgDelete = await accept(
      byName.delete({
        params: { name: "MY_SECRET" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrgList.body.error.code).toBe("UNAUTHORIZED");
    expect(noOrgSet.body.error.code).toBe("UNAUTHORIZED");
    expect(noOrgDelete.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates, updates, lists, hides values, isolates, and deletes user secrets", async () => {
    const owner = actor();
    const sameOrgOtherUser = {
      orgId: owner.orgId,
      userId: `user_${randomUUID()}`,
    };
    const otherOrg = actor();
    const alpha = secretName("A_SECRET");
    const zed = secretName("Z_SECRET");
    const shared = secretName("SHARED_SECRET");
    const otherOrgName = secretName("OTHER_ORG_SECRET");

    mocks.clerk.session(owner.userId, owner.orgId);
    const empty = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );
    const invalidName = await accept(
      secretsClient().set({
        headers: authHeaders(),
        body: { name: "invalid name", value: "secret-value" },
      }),
      [400],
    );
    const emptyValue = await accept(
      secretsClient().set({
        headers: authHeaders(),
        body: { name: "MY_SECRET", value: "" },
      }),
      [400],
    );

    expect(empty.body).toStrictEqual({ secrets: [] });
    expect(invalidName.body.error.code).toBe("BAD_REQUEST");
    expect(emptyValue.body.error.code).toBe("BAD_REQUEST");

    await createSecret({
      actor: owner,
      name: zed,
      value: "zed-v1",
    });
    await createSecret({
      actor: owner,
      name: alpha,
      value: "alpha-v1",
      description: "alpha",
    });
    await createSecret({
      actor: sameOrgOtherUser,
      name: shared,
      value: "same-org-other-user",
    });
    await createSecret({
      actor: otherOrg,
      name: otherOrgName,
      value: "other-org",
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    const listed = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      listed.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual([alpha, zed]);
    expect(listed.body.secrets[0]).toMatchObject({
      name: alpha,
      description: "alpha",
      type: "user",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    for (const secret of listed.body.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("encryptedValue");
    }

    const updated = await accept(
      secretsClient().set({
        headers: authHeaders(),
        body: {
          name: zed,
          value: "zed-v2",
          description: "updated zed",
        },
      }),
      [200],
    );
    const afterUpdate = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(updated.body).toMatchObject({
      name: zed,
      description: "updated zed",
      type: "user",
    });
    expect(
      afterUpdate.body.secrets.filter((secret) => {
        return secret.name === zed;
      }),
    ).toHaveLength(1);
    expect(
      afterUpdate.body.secrets.find((secret) => {
        return secret.name === zed;
      }),
    ).toMatchObject({ description: "updated zed" });

    const crossUserDelete = await accept(
      secretByNameClient().delete({
        params: { name: shared },
        headers: authHeaders(),
      }),
      [404],
    );
    const crossOrgDelete = await accept(
      secretByNameClient().delete({
        params: { name: otherOrgName },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(crossUserDelete.body.error.code).toBe("NOT_FOUND");
    expect(crossOrgDelete.body.error.code).toBe("NOT_FOUND");

    mocks.clerk.session(sameOrgOtherUser.userId, sameOrgOtherUser.orgId);
    const sameOrgOtherUserList = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      sameOrgOtherUserList.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual([shared]);

    mocks.clerk.session(otherOrg.userId, otherOrg.orgId);
    const otherOrgList = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );
    expect(
      otherOrgList.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual([otherOrgName]);

    mocks.clerk.session(owner.userId, owner.orgId);
    const deleted = await secretByNameClient().delete({
      params: { name: alpha },
      headers: authHeaders(),
    });
    const deleteAgain = await accept(
      secretByNameClient().delete({
        params: { name: alpha },
        headers: authHeaders(),
      }),
      [404],
    );
    const afterDelete = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(deleted.status).toBe(204);
    expect(deleteAgain.body).toStrictEqual({
      error: { message: `Secret "${alpha}" not found`, code: "NOT_FOUND" },
    });
    expect(
      afterDelete.body.secrets.map((secret) => {
        return secret.name;
      }),
    ).toStrictEqual([zed]);
  });

  it("uses the external KMS data-key boundary when the KMS key env is set", async () => {
    const kms = fakeKmsClient();
    const owner = actor();
    const name = secretName("KMS_SECRET");
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");

    await createSecret({
      actor: owner,
      name,
      value: "secret-value",
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    const listed = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(kms.calls).toHaveLength(1);
    expect(kms.calls[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(listed.body.secrets).toMatchObject([
      {
        name,
        type: "user",
      },
    ]);
    expect(listed.body.secrets[0]).not.toHaveProperty("value");
    expect(listed.body.secrets[0]).not.toHaveProperty("encryptedValue");
  });
});
