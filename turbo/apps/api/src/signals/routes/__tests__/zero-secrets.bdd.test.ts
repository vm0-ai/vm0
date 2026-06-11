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
  deleteUserData$,
  seedOtherSecret$,
  seedSecrets$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

// BDD migration of the legacy `zero-secrets.test.ts`.
// The 11 legacy `it()`s collapse into 3 BDD `it()`s:
// (1) GET /api/zero/secrets list chain (401
// unauthenticated → 401 no org → 200 returns current
// user secret metadata sorted by name → 200 returns an
// empty list when the user has no secrets),
// (2) POST /api/zero/secrets auth + create + KMS
// chain (401 unauthenticated → 401 no org → 200
// creates a user secret and stores an encrypted value
// → 200 uses KMS data-key envelope encryption when
// SECRETS_KMS_KEY_ID is set),
// (3) POST /api/zero/secrets update + validation +
// isolation chain (200 updates an existing user
// secret without creating a duplicate → 400 invalid
// name → 400 empty value → 200 does not overwrite
// another user's secret with the same name).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const dataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

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

function apiClient() {
  return setupApp({ context })(zeroSecretsContract);
}

function sessionHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("BDD GET /api/zero/secrets — list chain", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("gwt-wt-wt: 401 unauthenticated → 401 no org → 200 returns current user secret metadata sorted by name → 200 returns an empty list when the user has no secrets", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(apiClient().list({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().list({ headers: sessionHeaders() }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture with two seeded secrets (Z_TOKEN
    // + A_TOKEN) + a Clerk session for that user.

    // When + Then: 200 — the response returns 2
    // secrets sorted by name (A first, Z second) +
    // neither row exposes the value/encryptedValue.
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const updatedAt = new Date("2026-01-03T03:04:05.000Z");
    const sortedFixture = await track(
      store.set(
        seedSecrets$,
        [
          {
            name: "Z_TOKEN",
            description: null,
            type: "connector",
            createdAt,
            updatedAt,
          },
          {
            name: "A_TOKEN",
            description: "alpha",
            type: "user",
            createdAt,
            updatedAt,
          },
        ],
        context.signal,
      ),
    );
    await store.set(seedOtherSecret$, sortedFixture, context.signal);
    mocks.clerk.session(sortedFixture.userId, sortedFixture.orgId);
    const sortedResponse = await accept(
      apiClient().list({ headers: sessionHeaders() }),
      [200],
    );
    expect(sortedResponse.body.secrets).toHaveLength(2);
    expect(sortedResponse.body.secrets).toMatchObject([
      {
        name: "A_TOKEN",
        description: "alpha",
        type: "user",
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-03T03:04:05.000Z",
      },
      {
        name: "Z_TOKEN",
        description: null,
        type: "connector",
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-03T03:04:05.000Z",
      },
    ]);
    for (const secret of sortedResponse.body.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("encryptedValue");
    }

    // Given: a fixture with no seeded secrets + a
    // Clerk session for that user.

    // When + Then: 200 — empty list.
    const emptyFixture = await track(
      store.set(seedSecrets$, [], context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);
    const emptyResponse = await accept(
      apiClient().list({ headers: sessionHeaders() }),
      [200],
    );
    expect(emptyResponse.body).toStrictEqual({ secrets: [] });
  });
});

describe("BDD POST /api/zero/secrets — auth + create + KMS chain", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("gwt-wt-wt: 401 unauthenticated → 401 no org → 200 creates a user secret and stores an encrypted value → 200 uses KMS data-key envelope encryption when SECRETS_KMS_KEY_ID is set", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      apiClient().set({
        headers: {},
        body: {
          name: "MY_SECRET",
          value: "secret-value",
        },
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "MY_SECRET",
          value: "secret-value",
        },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a fixture with no seeded secrets + a
    // Clerk session for that user.

    // When + Then: 200 — the response echoes the
    // expected name/description/type + id/createdAt/
    // updatedAt are set + the row never exposes the
    // plain value/encryptedValue in the API body +
    // the DB row stores the encrypted value (not the
    // plain text).
    const createFixture = await track(
      store.set(seedSecrets$, [], context.signal),
    );
    mocks.clerk.session(createFixture.userId, createFixture.orgId);
    const createResponse = await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "MY_SECRET",
          value: "secret-value",
          description: "Test secret",
        },
      }),
      [200],
    );
    expect(createResponse.body).toMatchObject({
      name: "MY_SECRET",
      description: "Test secret",
      type: "user",
    });
    expect(createResponse.body.id).toBeDefined();
    expect(createResponse.body.createdAt).toBeDefined();
    expect(createResponse.body.updatedAt).toBeDefined();
    expect(createResponse.body).not.toHaveProperty("value");
    expect(createResponse.body).not.toHaveProperty("encryptedValue");

    const createWriteDb = store.set(writeDb$);
    const createRows = await createWriteDb
      .select({
        encryptedValue: secrets.encryptedValue,
        type: secrets.type,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, createFixture.orgId),
          eq(secrets.userId, createFixture.userId),
          eq(secrets.name, "MY_SECRET"),
        ),
      );
    expect(createRows).toHaveLength(1);
    expect(createRows[0]?.type).toBe("user");
    expect(createRows[0]?.encryptedValue).not.toBe("secret-value");

    // Given: a fixture with no seeded secrets + a
    // KMS client + SECRETS_KMS_KEY_ID set + a Clerk
    // session for that user.

    // When + Then: 200 — exactly one GenerateDataKey
    // call is made + the stored encrypted value
    // matches the KMS envelope shape (no legacy field,
    // non-empty encryptedDataKey).
    const kms = fakeKmsClient();
    setSecretKmsClientForTests(kms.client);
    mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets");
    const kmsFixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(kmsFixture.userId, kmsFixture.orgId);
    await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "MY_SECRET",
          value: "secret-value",
        },
      }),
      [200],
    );
    const kmsWriteDb = store.set(writeDb$);
    const [kmsRow] = await kmsWriteDb
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, kmsFixture.orgId),
          eq(secrets.userId, kmsFixture.userId),
          eq(secrets.name, "MY_SECRET"),
          eq(secrets.type, "user"),
        ),
      )
      .limit(1);
    expect(kms.calls).toHaveLength(1);
    expect(kms.calls[0]).toBeInstanceOf(GenerateDataKeyCommand);
    if (!kmsRow) {
      throw new Error("Expected secret row to be written");
    }
    const envelope = storedSecretEnvelope(kmsRow.encryptedValue);
    expect(envelope.legacy).toBeUndefined();
    expect(envelope.kms?.encryptedDataKey).toBeTruthy();
  });
});

describe("BDD POST /api/zero/secrets — update + validation + isolation chain", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("gwt-wt-wt: 200 updates an existing user secret without creating a duplicate → 400 invalid name → 400 empty value → 200 does not overwrite another user's secret with the same name", async () => {
    // Given: a fixture with no seeded secrets + a
    // Clerk session for that user.

    // When + Then: 200 — the first create + the
    // second create share the same id + the second
    // update reflects the new description + exactly
    // one row exists in the DB with the updated
    // description and an encrypted value.
    const updateFixture = await track(
      store.set(seedSecrets$, [], context.signal),
    );
    mocks.clerk.session(updateFixture.userId, updateFixture.orgId);
    const created = await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "MY_SECRET",
          value: "value-v1",
          description: "Initial description",
        },
      }),
      [200],
    );
    const updated = await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "MY_SECRET",
          value: "value-v2",
          description: "Updated description",
        },
      }),
      [200],
    );
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body.name).toBe("MY_SECRET");
    expect(updated.body.description).toBe("Updated description");
    const updateWriteDb = store.set(writeDb$);
    const updateRows = await updateWriteDb
      .select({
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, updateFixture.orgId),
          eq(secrets.userId, updateFixture.userId),
          eq(secrets.name, "MY_SECRET"),
          eq(secrets.type, "user"),
        ),
      );
    expect(updateRows).toHaveLength(1);
    expect(updateRows[0]?.description).toBe("Updated description");
    expect(updateRows[0]?.encryptedValue).not.toBe("value-v2");

    // Given: a fixture with no seeded secrets + a
    // Clerk session + an invalid (whitespace) name.

    // When + Then: 400 — BAD_REQUEST.
    const invalidNameFixture = await track(
      store.set(seedSecrets$, [], context.signal),
    );
    mocks.clerk.session(invalidNameFixture.userId, invalidNameFixture.orgId);
    const invalidNameResponse = await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "invalid name",
          value: "secret-value",
        },
      }),
      [400],
    );
    expect(invalidNameResponse.body.error.code).toBe("BAD_REQUEST");

    // Given: a fixture with no seeded secrets + a
    // Clerk session + an empty value.

    // When + Then: 400 — BAD_REQUEST.
    const emptyValueFixture = await track(
      store.set(seedSecrets$, [], context.signal),
    );
    mocks.clerk.session(emptyValueFixture.userId, emptyValueFixture.orgId);
    const emptyValueResponse = await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "MY_SECRET",
          value: "",
        },
      }),
      [400],
    );
    expect(emptyValueResponse.body.error.code).toBe("BAD_REQUEST");

    // Given: a fixture with no seeded secrets + a
    // pre-existing SHARED_SECRET for a different
    // user in the same org + a Clerk session for the
    // current user.

    // When + Then: 200 — the current user's create
    // succeeds with the expected description + the
    // DB has exactly 2 rows: the other user's row is
    // untouched + the current user's row has the new
    // description.
    const isolationFixture = await track(
      store.set(seedSecrets$, [], context.signal),
    );
    const otherUserId = `user_${randomUUID()}`;
    const isolationWriteDb = store.set(writeDb$);
    await isolationWriteDb.insert(secrets).values({
      orgId: isolationFixture.orgId,
      userId: otherUserId,
      name: "SHARED_SECRET",
      encryptedValue: "other-user-encrypted",
      description: "Other user",
      type: "user",
    });
    mocks.clerk.session(isolationFixture.userId, isolationFixture.orgId);
    const isolationResponse = await accept(
      apiClient().set({
        headers: sessionHeaders(),
        body: {
          name: "SHARED_SECRET",
          value: "current-user-value",
          description: "Current user",
        },
      }),
      [200],
    );
    expect(isolationResponse.body.description).toBe("Current user");
    const isolationRows = await isolationWriteDb
      .select({
        userId: secrets.userId,
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, isolationFixture.orgId),
          eq(secrets.name, "SHARED_SECRET"),
          eq(secrets.type, "user"),
        ),
      );
    expect(isolationRows).toHaveLength(2);
    expect(
      isolationRows.find((row) => {
        return row.userId === otherUserId;
      }),
    ).toMatchObject({
      encryptedValue: "other-user-encrypted",
      description: "Other user",
    });
    expect(
      isolationRows.find((row) => {
        return row.userId === isolationFixture.userId;
      }),
    ).toMatchObject({
      description: "Current user",
    });
  });
});
