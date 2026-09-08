import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SSH_CONNECTION_LIMIT,
  sshConnectionsContract,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { testSshConnectionStateContract } from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { sshConnectionsRoutes } from "../ssh-connections";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const context = testContext();
const mocks = createRouteMocks(context);
const authApi = createAuthOrgAgentsBddApi(context);

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

function actor(prefix: string, orgId = STAFF_ORG_ID): Actor {
  return { orgId, userId: `user_ssh_${prefix}_${randomUUID()}` };
}

function authenticate(
  value: Actor | { readonly orgId: null; readonly userId: string },
) {
  mocks.clerk.session(value.userId, value.orgId);
}

async function enableSsh(value: Actor): Promise<void> {
  await updateFeatureSwitchesForUser(context, value, {
    [FeatureSwitchKey.SshAccess]: true,
  });
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}

function stateClient() {
  return setupApp({ context, routes: testSshConnectionStateRoutes })(
    testSshConnectionStateContract,
  );
}

function createBody(
  host: string,
  overrides: Partial<{
    readonly displayName: string;
    readonly port: number;
    readonly username: string;
    readonly privateKey: string;
    readonly passphrase: string | null;
  }> = {},
) {
  return {
    displayName: overrides.displayName ?? `Host ${host}`,
    host,
    port: overrides.port ?? 22,
    username: overrides.username ?? "deploy",
    privateKey: overrides.privateKey ?? "private-key",
    passphrase: overrides.passphrase ?? null,
  };
}

describe("SSH connection routes", () => {
  it("requires an organization session and both rollout gates before parsing input", async () => {
    const kms = useSecretKmsProbe();
    const unauthenticated = await accept(client().list({ headers: {} }), [401]);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    authenticate({ userId: `user_ssh_no_org_${randomUUID()}`, orgId: null });
    const withoutOrg = await accept(
      client().list({ headers: authHeaders() }),
      [401],
    );
    expect(withoutOrg.body.error.code).toBe("UNAUTHORIZED");

    const patActor = authApi.user({ orgId: STAFF_ORG_ID });
    authApi.mockClerkOrg(patActor);
    const pat = await authApi.createCliToken(patActor);
    const patResponse = await accept(
      client().list({
        headers: { authorization: `Bearer ${pat.token}` },
      }),
      [403],
    );
    expect(patResponse.body.error.code).toBe("FORBIDDEN");

    const nonStaff = actor("nonstaff", `org_ssh_${randomUUID()}`);
    await enableSsh(nonStaff);
    const nonStaffResponse = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("nonstaff.example.com"),
      }),
      [404],
    );
    expect(nonStaffResponse.body.error.message).toBe(
      "SSH configuration is not available",
    );

    const staffWithoutSwitch = actor("disabled");
    authenticate(staffWithoutSwitch);
    const disabledResponse = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("disabled.example.com"),
      }),
      [404],
    );
    expect(disabledResponse.body).toStrictEqual(nonStaffResponse.body);

    const rawResponse = await setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    })("/api/ssh/connections", {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({ unexpected: true }),
    });
    expect(rawResponse.status).toBe(404);
    expect(kms.generateDataKeyCalls).toBe(0);
  });

  it("creates, normalizes, lists, edits, resets, and deletes without exposing secrets", async () => {
    useSecretKmsProbe();
    const owner = actor("crud");
    await enableSsh(owner);
    const privateKey = "  -----BEGIN KEY-----\nvalue\n-----END KEY-----\n";
    const passphrase = " passphrase with spaces ";

    const created = await accept(
      client().create({
        headers: authHeaders(),
        body: {
          displayName: "  Production  ",
          host: "  BÜCHER.Example.  ",
          username: "  deploy  ",
          privateKey,
          passphrase,
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      displayName: "Production",
      host: "xn--bcher-kva.example",
      port: 22,
      username: "deploy",
      generation: 1,
      learnedHostKey: null,
    });
    expect(created.body).not.toHaveProperty("privateKey");
    expect(created.body).not.toHaveProperty("passphrase");
    expect(created.body).not.toHaveProperty("status");
    expect(created.body).not.toHaveProperty("account");
    expect(JSON.stringify(created.body)).not.toContain("vm0secret:");

    const credentialMatch = await accept(
      stateClient().action({
        body: {
          action: "match-credentials",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          privateKey,
          passphrase,
        },
      }),
      [200],
    );
    expect(credentialMatch.body).toMatchObject({
      privateKeyMatches: true,
      passphraseMatches: true,
    });

    const summary = await accept(
      client().summary({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body).toStrictEqual({ configuredCount: 1, limit: 64 });
    const listed = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([created.body]);

    const pinned = await accept(
      stateClient().action({
        body: {
          action: "set-learned-host-key",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:test",
        },
      }),
      [200],
    );
    expect(pinned.body.generation).toBe(2);

    const metadataUpdated = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 2,
          displayName: "Renamed",
          username: "operator",
        },
      }),
      [200],
    );
    expect(metadataUpdated.body).toMatchObject({
      generation: 3,
      learnedHostKey: {
        algorithm: "ssh-ed25519",
        fingerprint: "SHA256:test",
      },
    });

    const credentialUpdated = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 3,
          credentials: { privateKey: "replacement\n", passphrase: null },
        },
      }),
      [200],
    );
    expect(credentialUpdated.body.generation).toBe(4);
    expect(credentialUpdated.body.learnedHostKey).not.toBeNull();

    const replacementMatch = await accept(
      stateClient().action({
        body: {
          action: "match-credentials",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          privateKey: "replacement\n",
          passphrase: null,
        },
      }),
      [200],
    );
    expect(replacementMatch.body).toMatchObject({
      privateKeyMatches: true,
      passphraseMatches: true,
    });

    const endpointUpdated = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 4,
          host: "2001:0DB8:0:0::1",
          port: 2222,
        },
      }),
      [200],
    );
    expect(endpointUpdated.body).toMatchObject({
      host: "2001:db8::1",
      port: 2222,
      generation: 5,
      learnedHostKey: null,
    });

    const repinned = await accept(
      stateClient().action({
        body: {
          action: "set-learned-host-key",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:replacement",
        },
      }),
      [200],
    );
    const reset = await accept(
      client().resetHostKey({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: repinned.body.generation ?? 0 },
      }),
      [200],
    );
    expect(reset.body).toMatchObject({ generation: 7, learnedHostKey: null });

    const resetAgain = await accept(
      client().resetHostKey({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: 7 },
      }),
      [200],
    );
    expect(resetAgain.body).toMatchObject({
      generation: 8,
      learnedHostKey: null,
    });

    const stale = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: 7, displayName: "Stale" },
      }),
      [409],
    );
    expect(stale.body.error.message).toContain("modified");

    const staleReset = await accept(
      client().resetHostKey({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: { expectedGeneration: 7 },
      }),
      [409],
    );
    expect(staleReset.body.error.message).toContain("modified");

    await accept(
      client().delete({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
      }),
      [204],
    );
    const afterDelete = await accept(
      stateClient().action({
        body: {
          action: "match-credentials",
          orgId: owner.orgId,
          userId: owner.userId,
          connectionId: created.body.id,
          privateKey: "replacement\n",
          passphrase: null,
        },
      }),
      [400],
    );
    expect(afterDelete.body.error).toBe("Connection not found");
  });

  it("rejects invalid and duplicate endpoints before KMS work", async () => {
    const kms = useSecretKmsProbe();
    const owner = actor("validation");
    await enableSsh(owner);

    const invalidHosts = [
      "[::1]",
      "example.com:22",
      "https://example.com",
      "bad host",
      "-bad.example",
      "example..com",
      "127.0.0.999",
      "example.com..",
    ];
    for (const host of invalidHosts) {
      const response = await accept(
        client().create({ headers: authHeaders(), body: createBody(host) }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
    }
    expect(kms.generateDataKeyCalls).toBe(0);

    const created = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("EXAMPLE.com."),
      }),
      [201],
    );
    expect(created.body.host).toBe("example.com");
    expect(kms.generateDataKeyCalls).toBe(1);

    const duplicate = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("example.COM"),
      }),
      [409],
    );
    expect(duplicate.body.error.message).toContain("already exists");
    expect(kms.generateDataKeyCalls).toBe(1);

    const other = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("other.example.com"),
      }),
      [201],
    );
    const endpointCollision = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: other.body.id },
        body: { expectedGeneration: 1, host: "EXAMPLE.com." },
      }),
      [409],
    );
    expect(endpointCollision.body.error.message).toContain("already exists");
    expect(kms.generateDataKeyCalls).toBe(2);

    const rawRequest = setupRawAppRequest({
      context,
      routes: sshConnectionsRoutes,
    });
    const unknownField = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("other.example.com"),
        unexpected: true,
      }),
    });
    expect(unknownField.status).toBe(400);

    const invalidPort = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("invalid-port.example.com"),
        port: 65_536,
      }),
    });
    expect(invalidPort.status).toBe(400);

    const invalidPrivateKey = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("invalid-key.example.com"),
        privateKey: "",
      }),
    });
    expect(invalidPrivateKey.status).toBe(400);

    const invalidPassphrase = await rawRequest("/api/ssh/connections", {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        ...createBody("invalid-passphrase.example.com"),
        passphrase: "",
      }),
    });
    expect(invalidPassphrase.status).toBe(400);

    const emptyPatch = await rawRequest(
      `/api/ssh/connections/${created.body.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      },
    );
    expect(emptyPatch.status).toBe(400);

    const invalidGeneration = await rawRequest(
      `/api/ssh/connections/${created.body.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 0, displayName: "Invalid" }),
      },
    );
    expect(invalidGeneration.status).toBe(400);
    expect(kms.generateDataKeyCalls).toBe(2);
  });

  it("fails closed across owners without invoking KMS", async () => {
    const kms = useSecretKmsProbe();
    const owner = actor("owner");
    await enableSsh(owner);
    const created = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("isolated.example.com"),
      }),
      [201],
    );
    expect(kms.generateDataKeyCalls).toBe(1);

    const other = actor("other");
    await enableSsh(other);
    const crossOwner = await accept(
      client().update({
        headers: authHeaders(),
        params: { connectionId: created.body.id },
        body: {
          expectedGeneration: 1,
          credentials: { privateKey: "should-not-encrypt", passphrase: null },
        },
      }),
      [404],
    );
    expect(crossOwner.body.error.message).toBe("SSH connection not found");
    expect(kms.generateDataKeyCalls).toBe(1);

    const otherList = await accept(
      client().list({ headers: authHeaders() }),
      [200],
    );
    expect(otherList.body.connections).toStrictEqual([]);
  });

  it("serializes duplicate creates and the final quota slots", async () => {
    useSecretKmsProbe();
    const duplicateOwner = actor("concurrent-duplicate");
    await enableSsh(duplicateOwner);
    const duplicateResults = await Promise.all([
      client().create({
        headers: authHeaders(),
        body: createBody("RACE.example.com"),
      }),
      client().create({
        headers: authHeaders(),
        body: createBody("race.example.com."),
      }),
    ]);
    expect(
      duplicateResults
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);

    const quotaOwner = actor("concurrent-quota");
    await enableSsh(quotaOwner);
    const seeded = await Promise.all(
      Array.from({ length: SSH_CONNECTION_LIMIT - 1 }, (_, index) => {
        return client().create({
          headers: authHeaders(),
          body: createBody(`seed-${index}.example.com`),
        });
      }),
    );
    expect(
      seeded.every((result) => {
        return result.status === 201;
      }),
    ).toBeTruthy();

    const quotaResults = await Promise.all([
      client().create({
        headers: authHeaders(),
        body: createBody("final-a.example.com"),
      }),
      client().create({
        headers: authHeaders(),
        body: createBody("final-b.example.com"),
      }),
    ]);
    expect(
      quotaResults
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([201, 409]);
    const summary = await accept(
      client().summary({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.configuredCount).toBe(SSH_CONNECTION_LIMIT);
  });

  it("leaves no visible row when KMS encryption fails", async () => {
    const owner = actor("kms-failure");
    await enableSsh(owner);
    const kms = useSecretKmsProbe(() => {
      return Promise.reject(new Error("KMS unavailable"));
    });

    const response = await accept(
      client().create({
        headers: authHeaders(),
        body: createBody("kms-failure.example.com"),
      }),
      [500],
    );
    expect(JSON.stringify(response.body)).not.toContain("KMS unavailable");
    expect(kms.generateDataKeyCalls).toBe(1);

    const summary = await accept(
      client().summary({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.configuredCount).toBe(0);
  });
});
