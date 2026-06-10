import { randomUUID } from "node:crypto";

import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { secrets } from "@vm0/db/schema/secret";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  STORED_SECRET_ENVELOPE_PREFIX,
  type SecretKmsClient,
} from "../../services/crypto.utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  authHeaders,
  createZeroSecretThroughApi,
  deleteZeroSecretThroughApi,
  listZeroSecretsThroughApi,
  setZeroSecretThroughApi,
  type ZeroSecretRouteFixture,
} from "./helpers/zero-secret-routes";
import {
  deleteUserData$,
  seedSecrets$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const dataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const trackLegacy = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});
const trackSecret = createFixtureTracker<ZeroSecretRouteFixture>((fixture) => {
  return deleteZeroSecretThroughApi(context, mocks.clerk.session, fixture);
});

type MockKmsCommand = GenerateDataKeyCommand | DecryptCommand;
type MockKmsResponse = GenerateDataKeyCommandOutput | DecryptCommandOutput;

function fakeKmsClient(): {
  readonly calls: readonly MockKmsCommand[];
  readonly client: SecretKmsClient;
} {
  const calls: MockKmsCommand[] = [];

  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(command: MockKmsCommand): Promise<MockKmsResponse> {
    calls.push(command);

    if (command instanceof GenerateDataKeyCommand) {
      return Promise.resolve({
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: dataKey,
      });
    }

    return Promise.resolve({ $metadata: {}, Plaintext: dataKey });
  }

  return { calls, client: { send } };
}

function storedSecretEnvelope(encryptedValue: string): {
  readonly legacy?: string;
  readonly kms?: {
    readonly encryptedDataKey?: string;
    readonly ciphertext?: string;
  };
} {
  expect(encryptedValue.startsWith(STORED_SECRET_ENVELOPE_PREFIX)).toBeTruthy();
  return JSON.parse(
    Buffer.from(
      encryptedValue.slice(STORED_SECRET_ENVELOPE_PREFIX.length),
      "base64url",
    ).toString("utf8"),
  ) as {
    readonly legacy?: string;
    readonly kms?: {
      readonly encryptedDataKey?: string;
      readonly ciphertext?: string;
    };
  };
}

afterEach(() => {
  clearMockedEnv();
  resetSecretKmsClientForTests();
});

describe("GET /api/zero/secrets", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns current user secret metadata sorted by name", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    await trackSecret(
      createZeroSecretThroughApi(context, mocks.clerk.session, {
        userId,
        orgId,
        name: "Z_TOKEN",
      }),
    );
    await trackSecret(
      createZeroSecretThroughApi(context, mocks.clerk.session, {
        userId,
        orgId,
        name: "A_TOKEN",
        description: "alpha",
      }),
    );
    await trackSecret(
      createZeroSecretThroughApi(context, mocks.clerk.session, {
        userId: `user_${randomUUID().slice(0, 8)}`,
        orgId,
        name: "OTHER_USER_SECRET",
        description: "other-user",
      }),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.secrets).toHaveLength(2);
    expect(response.body.secrets).toMatchObject([
      {
        name: "A_TOKEN",
        description: "alpha",
        type: "user",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      {
        name: "Z_TOKEN",
        description: null,
        type: "user",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    for (const secret of response.body.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("encryptedValue");
    }
  });

  it("returns connector-owned secret metadata from legacy rows", async () => {
    const fixture = await trackLegacy(
      store.set(
        seedSecrets$,
        [
          {
            name: "CONNECTOR_TOKEN",
            description: "connector",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.secrets).toMatchObject([
      {
        name: "CONNECTOR_TOKEN",
        description: "connector",
        type: "connector",
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);
    expect(response.body.secrets[0]).not.toHaveProperty("value");
    expect(response.body.secrets[0]).not.toHaveProperty("encryptedValue");
  });

  it("returns an empty list when the user has no secrets", async () => {
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ secrets: [] });
  });
});

describe("POST /api/zero/secrets", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: {},
        body: {
          name: "MY_SECRET",
          value: "secret-value",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: authHeaders(),
        body: {
          name: "MY_SECRET",
          value: "secret-value",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("creates a user secret and stores an encrypted value", async () => {
    const fixture = await trackSecret(
      Promise.resolve({
        orgId: `org_${randomUUID().slice(0, 8)}`,
        userId: `user_${randomUUID().slice(0, 8)}`,
        name: "MY_SECRET",
      }),
    );
    const secret = await setZeroSecretThroughApi(
      context,
      mocks.clerk.session,
      fixture,
      {
        value: "secret-value",
        description: "Test secret",
      },
    );

    expect(secret).toMatchObject({
      name: "MY_SECRET",
      description: "Test secret",
      type: "user",
    });
    expect(secret.id).toBeDefined();
    expect(secret.createdAt).toBeDefined();
    expect(secret.updatedAt).toBeDefined();
    expect(secret).not.toHaveProperty("value");
    expect(secret).not.toHaveProperty("encryptedValue");
    await expect(listZeroSecretsThroughApi(context)).resolves.toMatchObject([
      {
        name: "MY_SECRET",
        description: "Test secret",
        type: "user",
      },
    ]);

    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({
        encryptedValue: secrets.encryptedValue,
        type: secrets.type,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "MY_SECRET"),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("user");
    expect(rows[0]?.encryptedValue).not.toBe("secret-value");
  });

  it("uses KMS data-key envelope encryption when SECRETS_KMS_KEY_ID is set", async () => {
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    const fixture = await trackSecret(
      Promise.resolve({
        orgId: `org_${randomUUID().slice(0, 8)}`,
        userId: `user_${randomUUID().slice(0, 8)}`,
        name: "MY_SECRET",
      }),
    );
    await setZeroSecretThroughApi(context, mocks.clerk.session, fixture, {
      value: "secret-value",
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "MY_SECRET"),
          eq(secrets.type, "user"),
        ),
      )
      .limit(1);

    expect(kms.calls).toHaveLength(1);
    expect(kms.calls[0]).toBeInstanceOf(GenerateDataKeyCommand);
    if (!row) {
      throw new Error("Expected secret row to be written");
    }
    const envelope = storedSecretEnvelope(row.encryptedValue);
    expect(envelope.legacy).toBeUndefined();
    expect(envelope.kms?.encryptedDataKey).toBeTruthy();
  });

  it("updates an existing user secret without creating a duplicate", async () => {
    const fixture = await trackSecret(
      Promise.resolve({
        orgId: `org_${randomUUID().slice(0, 8)}`,
        userId: `user_${randomUUID().slice(0, 8)}`,
        name: "MY_SECRET",
      }),
    );
    const created = await setZeroSecretThroughApi(
      context,
      mocks.clerk.session,
      fixture,
      {
        value: "value-v1",
        description: "Initial description",
      },
    );

    const updated = await setZeroSecretThroughApi(
      context,
      mocks.clerk.session,
      fixture,
      {
        value: "value-v2",
        description: "Updated description",
      },
    );

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe("MY_SECRET");
    expect(updated.description).toBe("Updated description");

    const listed = await listZeroSecretsThroughApi(context);
    expect(listed).toHaveLength(1);
    expect(listed).toMatchObject([
      {
        id: created.id,
        name: "MY_SECRET",
        description: "Updated description",
        type: "user",
      },
    ]);
  });

  it("returns 400 for invalid secret names", async () => {
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: authHeaders(),
        body: {
          name: "invalid name",
          value: "secret-value",
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for empty secret values", async () => {
    mocks.clerk.session(
      `user_${randomUUID().slice(0, 8)}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.set({
        headers: authHeaders(),
        body: {
          name: "MY_SECRET",
          value: "",
        },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
  });

  it("does not overwrite another user's secret with the same name", async () => {
    const orgId = `org_${randomUUID().slice(0, 8)}`;
    const otherUser = await trackSecret(
      createZeroSecretThroughApi(context, mocks.clerk.session, {
        orgId,
        userId: `user_${randomUUID().slice(0, 8)}`,
        name: "SHARED_SECRET",
        value: "other-user-value",
        description: "Other user",
      }),
    );
    const currentUser = await trackSecret(
      Promise.resolve({
        orgId,
        userId: `user_${randomUUID().slice(0, 8)}`,
        name: "SHARED_SECRET",
      }),
    );

    const response = await setZeroSecretThroughApi(
      context,
      mocks.clerk.session,
      currentUser,
      {
        value: "current-user-value",
        description: "Current user",
      },
    );

    expect(response.description).toBe("Current user");
    await expect(listZeroSecretsThroughApi(context)).resolves.toMatchObject([
      {
        name: "SHARED_SECRET",
        description: "Current user",
        type: "user",
      },
    ]);

    mocks.clerk.session(otherUser.userId, otherUser.orgId);
    await expect(listZeroSecretsThroughApi(context)).resolves.toMatchObject([
      {
        name: "SHARED_SECRET",
        description: "Other user",
        type: "user",
      },
    ]);
  });
});
