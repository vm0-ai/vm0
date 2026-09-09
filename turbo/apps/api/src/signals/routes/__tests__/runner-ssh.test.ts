import { randomUUID } from "node:crypto";

import { triggerSourceSchema } from "@okouai/api-contracts/contracts/logs";
import {
  runnerSshContract,
  type RunnerSshResolveRequest,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  testSshConnectionStateContract,
  type TestSshConnectionStateActionBody,
} from "@okouai/api-contracts/contracts/test-ssh-connection-state";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createDeferredPromise, onRejection } from "../../utils";
import { runnerSshRoutes } from "../runner-ssh";
import { sshConnectionsRoutes } from "../ssh-connections";
import { testSshConnectionStateRoutes } from "../test-ssh-connection-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const staffOrg = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });
const runnerSecret = "a".repeat(64);
const runnerHeaders = Object.freeze({
  authorization: `Bearer vm0_official_${runnerSecret}`,
});
const hostKey = Object.freeze({
  algorithm: "ssh-ed25519" as const,
  fingerprint: `SHA256:${Buffer.alloc(32, 1).toString("base64url").replaceAll("-", "+").replaceAll("_", "/")}`,
});
const otherHostKey = Object.freeze({
  ...hostKey,
  fingerprint: `SHA256:${Buffer.alloc(32, 2).toString("base64").replace(/=+$/u, "")}`,
});
const privateKey = "  private-key-canary\n";
const passphrase = " passphrase-canary ";
type RuntimeBody = Extract<
  TestSshConnectionStateActionBody,
  { action: "create-runtime" }
>;
interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

function client() {
  return setupApp({ context, routes: runnerSshRoutes })(runnerSshContract);
}
function config() {
  return setupApp({ context, routes: sshConnectionsRoutes })(
    sshConnectionsContract,
  );
}
function stateClient() {
  return setupApp({ context, routes: testSshConnectionStateRoutes })(
    testSshConnectionStateContract,
  );
}
function authenticate(owner: Owner) {
  mocks.clerk.session(owner.userId, owner.orgId);
}

async function createRuntime(
  owner: Owner,
  overrides: Partial<RuntimeBody> = {},
) {
  // Process generation is a bigint, independent of the connection's int generation.
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 5_000_000_000,
  };
  const r = await accept(
    stateClient().action({
      body: {
        action: "create-runtime",
        orgId: owner.orgId,
        userId: owner.userId,
        ...runnerIdentity,
        triggerSource: "web",
        status: "running",
        chat: true,
        access: true,
        ...overrides,
      },
    }),
    [200],
  );
  if (!r.body.runId || !r.body.agentId || !r.body.sandboxToken) {
    throw new Error("Missing runtime fixture identity");
  }
  return {
    runId: r.body.runId,
    agentId: r.body.agentId,
    sandboxToken: r.body.sandboxToken,
    runnerIdentity,
  };
}

async function fixture(runtimeOverrides: Partial<RuntimeBody> = {}) {
  const owner = { orgId: staffOrg, userId: `user_ssh_jit_${randomUUID()}` };
  await updateFeatureSwitchesForUser(context, owner, {
    [FeatureSwitchKey.SshAccess]: true,
  });
  authenticate(owner);
  const connection = await accept(
    config().create({
      headers: sessionHeaders,
      body: {
        displayName: "SSH fixture",
        host: "ssh.example.com",
        username: "deploy",
        privateKey,
        passphrase,
      },
    }),
    [201],
  );
  const runtime = await createRuntime(owner, runtimeOverrides);
  return { ...owner, ...runtime, connectionId: connection.body.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe("SSH authority invalidation", () => {
  it("notifies all active owner Runs after committed edits, rotations, reset and deletion", async () => {
    const group = `ssh-cache-${randomUUID()}`;
    const f = await fixture({ runnerGroup: group });
    const withoutGrant = await createRuntime(f, {
      runnerGroup: group,
      access: false,
    });
    await createRuntime(f, { runnerGroup: group, status: "completed" });
    await fixture({ runnerGroup: `other-${randomUUID()}` });
    authenticate(f);
    const expected = [f.runId, withoutGrant.runId].map((runId) => {
      return [
        "ssh-authority-invalidated",
        { runId, connectionId: f.connectionId },
      ];
    });
    const updates = [
      { host: "changed.example.com" },
      {
        credentials: {
          privateKey: "rotated-private-key",
          passphrase: "rotated-passphrase",
        },
      },
    ];
    let generation = 1;
    for (const update of updates) {
      context.mocks.ably.publish.mockClear();
      context.mocks.ably.channelGet.mockClear();
      const changed = await accept(
        config().update({
          headers: sessionHeaders,
          params: { connectionId: f.connectionId },
          body: { expectedGeneration: generation, ...update },
        }),
        [200],
      );
      generation = changed.body.generation;
      expect(context.mocks.ably.publish.mock.calls).toHaveLength(2);
      expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
        expect.arrayContaining(expected),
      );
      expect(context.mocks.ably.channelGet.mock.calls).toStrictEqual([
        [`runner-group:${group}`],
        [`runner-group:${group}`],
      ]);
    }
    context.mocks.ably.publish.mockClear();
    await accept(
      config().resetHostKey({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: generation },
      }),
      [200],
    );
    expect(context.mocks.ably.publish.mock.calls).toHaveLength(2);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
      expect.arrayContaining(expected),
    );
    context.mocks.ably.publish.mockClear();
    await accept(
      config().delete({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
      }),
      [204],
    );
    expect(context.mocks.ably.publish.mock.calls).toHaveLength(2);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual(
      expect.arrayContaining(expected),
    );
    const listed = await accept(
      config().list({ headers: sessionHeaders }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([]);
  });

  it("keeps committed mutations successful when notification delivery fails", async () => {
    const f = await fixture({ runnerGroup: `ssh-cache-${randomUUID()}` });
    context.mocks.ably.publish.mockClear();
    context.mocks.ably.publish.mockRejectedValue(
      new Error("Synthetic Ably publish failure"),
    );
    const changed = await accept(
      config().update({
        headers: sessionHeaders,
        params: { connectionId: f.connectionId },
        body: { expectedGeneration: 1, username: "new-login" },
      }),
      [200],
    );
    expect(changed.body.generation).toBe(2);
    const listed = await accept(
      config().list({ headers: sessionHeaders }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([
      expect.objectContaining({
        id: f.connectionId,
        generation: 2,
        username: "new-login",
      }),
    ]);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      [
        "ssh-authority-invalidated",
        { runId: f.runId, connectionId: f.connectionId },
      ],
    ]);
  });

  it("publishes only the successful generation when concurrent updates conflict", async () => {
    const f = await fixture({ runnerGroup: `ssh-cache-${randomUUID()}` });
    context.mocks.ably.publish.mockClear();
    const outcomes = await Promise.all(
      ["first-login", "second-login"].map(async (username) => {
        return await accept(
          config().update({
            headers: sessionHeaders,
            params: { connectionId: f.connectionId },
            body: { expectedGeneration: 1, username },
          }),
          [200, 409],
        );
      }),
    );
    expect(
      outcomes
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      [
        "ssh-authority-invalidated",
        { runId: f.runId, connectionId: f.connectionId },
      ],
    ]);
  });

  it("invalidates the affected Agent's whole Run even after its grant is deleted", async () => {
    const f = await fixture({ runnerGroup: `ssh-cache-${randomUUID()}` });
    await createRuntime(f, { runnerGroup: `other-agent-${randomUUID()}` });
    context.mocks.ably.publish.mockClear();
    await accept(
      stateClient().action({
        body: {
          action: "set-agent-access",
          orgId: f.orgId,
          userId: f.userId,
          agentId: f.agentId,
          enabled: false,
        },
      }),
      [200],
    );
    expect(context.mocks.ably.publish.mock.calls).toStrictEqual([
      ["ssh-authority-invalidated", { runId: f.runId, connectionId: null }],
    ]);
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
  });
});

async function resolve(
  f: Fixture,
  override: Partial<RunnerSshResolveRequest> = {},
) {
  const r = await accept(
    client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        ...override,
      },
    }),
    [200],
  );
  return r.body;
}
async function pin(
  f: Fixture,
  expectedGeneration = 1,
  observedHostKey = hostKey,
) {
  const r = await accept(
    client().pin({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        expectedGeneration,
        observedHostKey,
      },
    }),
    [200],
  );
  return r.body;
}
async function access(f: Fixture, enabled: boolean) {
  await accept(
    stateClient().action({
      body: {
        action: "set-agent-access",
        orgId: f.orgId,
        userId: f.userId,
        agentId: f.agentId,
        enabled,
      },
    }),
    [200],
  );
}
async function list(f: Fixture) {
  authenticate(f);
  return (await accept(config().list({ headers: sessionHeaders }), [200])).body
    .connections;
}

beforeEach(() => {
  mockEnv("OFFICIAL_RUNNER_SECRET", runnerSecret);
  useSecretKmsProbe();
});

describe("official Runner SSH authority", () => {
  it("keeps the hard staff gate even with an enabled override and matching ownership", async () => {
    const f = await fixture();
    const owner = { ...f, orgId: `org_external_${randomUUID()}` };
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.SshAccess]: true,
    });
    await accept(
      stateClient().action({
        body: {
          action: "move-connection-org",
          orgId: f.orgId,
          userId: f.userId,
          connectionId: f.connectionId,
          targetOrgId: owner.orgId,
        },
      }),
      [200],
    );
    const runtime = await createRuntime(owner);
    const kms = useSecretKmsProbe();
    await expect(resolve({ ...owner, ...runtime })).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    await expect(pin({ ...owner, ...runtime })).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
  });

  it("rechecks authority after waiting for an owner connection lock", async () => {
    for (const change of ["revoke", "disable", "delete-credential"] as const) {
      const f = await fixture({
        triggerSource: "automation-schedule",
        chat: false,
      });
      const scope = {
        orgId: f.orgId,
        userId: f.userId,
        connectionId: f.connectionId,
      };
      const lock = (
        action:
          | "hold-connection-lock"
          | "read-connection-lock"
          | "release-connection-lock",
      ) => {
        return accept(
          stateClient().action({ body: { action, ...scope } }),
          [200],
        );
      };
      const held = lock("hold-connection-lock");
      await expect
        .poll(async () => {
          return (await lock("read-connection-lock")).body.held;
        })
        .toBe(true);
      const pending = pin(f);
      const releaseLock = async () => {
        await lock("release-connection-lock");
        await Promise.all([held, pending]);
      };
      await onRejection(
        (async () => {
          await expect
            .poll(async () => {
              return (await lock("read-connection-lock")).body.waiting;
            })
            .toBe(true);
          if (change === "revoke") {
            await access(f, false);
          } else if (change === "disable") {
            await updateFeatureSwitchesForUser(context, f, {
              [FeatureSwitchKey.SshAccess]: false,
            });
          } else {
            await accept(
              stateClient().action({
                body: { action: "delete-credential", ...scope },
              }),
              [200],
            );
          }
        })(),
        releaseLock,
      );
      await releaseLock();
      await expect(pending).resolves.toStrictEqual({ outcome: "unavailable" });
      await updateFeatureSwitchesForUser(context, f, {
        [FeatureSwitchKey.SshAccess]: true,
      });
      expect((await list(f))[0]).toMatchObject({
        generation: 1,
        learnedHostKey: null,
      });
    }
  });

  it("does not turn a malformed stored host identity into unavailable or decrypt credentials", async () => {
    const f = await fixture();
    await accept(
      stateClient().action({
        body: {
          action: "set-learned-host-key",
          orgId: f.orgId,
          userId: f.userId,
          connectionId: f.connectionId,
          algorithm: "ssh-dss",
          fingerprint: "invalid",
        },
      }),
      [200],
    );
    const kms = useSecretKmsProbe();
    const result = await client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: { connectionId: f.connectionId, runnerIdentity: f.runnerIdentity },
    });
    expect(result.status).toBe(500);
    expect(kms.decryptCalls).toBe(0);
  });
  it("only delivers the exact current credential to the winning official process", async () => {
    const f = await fixture();
    const kms = useSecretKmsProbe();
    await expect(resolve(f)).resolves.toStrictEqual({
      outcome: "resolved",
      host: "ssh.example.com",
      port: 22,
      username: "deploy",
      generation: 1,
      learnedHostKey: null,
      privateKey,
      passphrase,
    });
    expect(kms.decryptCalls).toBe(2);
    const response = await client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: { connectionId: f.connectionId, runnerIdentity: f.runnerIdentity },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await list(f))).not.toContain("canary");
  });

  it("rejects unauthenticated, session, guest and local Runner credentials before decryption", async () => {
    const f = await fixture();
    const kms = useSecretKmsProbe();
    for (const authorization of [
      undefined,
      "Bearer vm0_official_wrong",
      "Bearer clerk-session",
      `Bearer ${f.sandboxToken}`,
    ]) {
      const r = await client().resolve({
        params: { runId: f.runId },
        headers: { authorization },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
        },
      });
      expect(r.status).toBe(401);
    }
    const authApi = createAuthOrgAgentsBddApi(context);
    const actor = authApi.user({ orgId: staffOrg });
    authApi.mockClerkOrg(actor);
    const pat = await authApi.createCliToken(actor);
    const rejected = await client().pin({
      params: { runId: f.runId },
      headers: { authorization: `Bearer ${pat.token}` },
      body: {
        connectionId: f.connectionId,
        runnerIdentity: f.runnerIdentity,
        expectedGeneration: 1,
        observedHostKey: hostKey,
      },
    });
    expect(rejected.status).toBe(403);
    expect(kms.decryptCalls).toBe(0);
    expect((await list(f))[0]?.learnedHostKey).toBeNull();
  });

  it("returns indistinguishable unavailable for wrong claims and hidden or missing connections", async () => {
    const f = await fixture({ triggerSource: "webhook", chat: false });
    const foreign = await fixture();
    const kms = useSecretKmsProbe();
    for (const override of [
      { connectionId: randomUUID() },
      { connectionId: foreign.connectionId },
      { runnerIdentity: { ...f.runnerIdentity, runnerId: randomUUID() } },
      { runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 8 } },
    ]) {
      await expect(resolve(f, override)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    }
    await expect(resolve({ ...f, runId: randomUUID() })).resolves.toStrictEqual(
      {
        outcome: "unavailable",
      },
    );
    expect(kms.decryptCalls).toBe(0);
    await expect(
      pin({ ...f, connectionId: foreign.connectionId }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect((await list(foreign))[0]?.learnedHostKey).toBeNull();
    // Keep the user and eligible staff Run unchanged: organization scoping must
    // deny this independently of the hard staff gate and user ownership check.
    await accept(
      stateClient().action({
        body: {
          action: "move-connection-org",
          orgId: f.orgId,
          userId: f.userId,
          connectionId: f.connectionId,
          targetOrgId: `org_hidden_${randomUUID()}`,
        },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("treats every chat channel equally", async () => {
    const f = await fixture();
    for (const triggerSource of [
      "web",
      "slack",
      "teams",
      "feishu",
      "email",
      "telegram",
      "agentphone",
      "github",
    ] as const) {
      const runtime = await createRuntime(f, { triggerSource });
      await expect(resolve({ ...f, ...runtime })).resolves.toMatchObject({
        outcome: "resolved",
        privateKey,
      });
    }
  });

  it.each([...triggerSourceSchema.options, null])(
    "resolves and pins an authorized %s Run without a chat thread",
    async (triggerSource) => {
      const f = await fixture({ triggerSource, chat: false });
      await expect(resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
        privateKey,
        learnedHostKey: null,
      });
      await expect(pin(f)).resolves.toStrictEqual({
        outcome: "pinned",
        generation: 2,
      });
      await expect(resolve(f)).resolves.toMatchObject({
        outcome: "resolved",
        learnedHostKey: hostKey,
        generation: 2,
      });
    },
  );

  it("denies inactive, unclaimed or ungranted Runs without a chat thread", async () => {
    const f = await fixture({ triggerSource: "automation-event", chat: false });
    const kms = useSecretKmsProbe();
    const denied: Partial<RuntimeBody>[] = [
      { access: false },
      { runnerId: null, heartbeatGeneration: null },
      { status: "pending" },
      { status: "completed" },
      { status: "cancelled" },
      { status: "failed" },
    ];
    for (const override of denied) {
      const runtime = await createRuntime(f, {
        triggerSource: "automation-event",
        chat: false,
        ...override,
      });
      await expect(resolve({ ...f, ...runtime })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(pin({ ...f, ...runtime })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    }
    expect(kms.decryptCalls).toBe(0);
  });

  it("checks current access, feature state and credential existence on every call", async () => {
    const f = await fixture({ triggerSource: "automation-event", chat: false });
    const kms = useSecretKmsProbe();
    await access(f, false);
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await access(f, true);
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: false,
    });
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.SshAccess]: true,
    });
    await accept(
      stateClient().action({
        body: {
          action: "delete-credential",
          orgId: f.orgId,
          userId: f.userId,
          connectionId: f.connectionId,
        },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("reflects credential rotation and deletion without a cached admission", async () => {
    const f = await fixture();
    await expect(pin(f)).resolves.toStrictEqual({
      outcome: "pinned",
      generation: 2,
    });
    authenticate(f);
    await accept(
      config().update({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
        body: {
          expectedGeneration: 2,
          username: "new-user",
          credentials: { privateKey: "rotated-key", passphrase: null },
        },
      }),
      [200],
    );
    await expect(resolve(f)).resolves.toMatchObject({
      outcome: "resolved",
      generation: 3,
      username: "new-user",
      privateKey: "rotated-key",
      passphrase: null,
      learnedHostKey: hostKey,
    });
    await expect(pin(f)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    authenticate(f);
    await accept(
      config().delete({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
      }),
      [204],
    );
    const kms = useSecretKmsProbe();
    await expect(resolve(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("pins exactly once for concurrent equal observations and only accepts expected plus one", async () => {
    const f = await fixture();
    const kms = useSecretKmsProbe();
    const outcomes = await Promise.all([pin(f), pin(f), pin(f)]);
    expect(
      outcomes.filter((r) => {
        return r.outcome === "pinned";
      }),
    ).toHaveLength(1);
    expect(
      outcomes.filter((r) => {
        return r.outcome === "matched";
      }),
    ).toHaveLength(2);
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(pin(f, 3)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    expect(kms.decryptCalls).toBe(0);
    expect((await list(f))[0]).toMatchObject({
      generation: 2,
      learnedHostKey: hostKey,
    });
  });

  it("never overwrites trust when concurrent first observations disagree", async () => {
    const f = await fixture();
    const result = await Promise.all([pin(f), pin(f, 1, otherHostKey)]);
    expect(
      result
        .map((r) => {
          return r.outcome;
        })
        .sort(),
    ).toStrictEqual(["host_key_mismatch", "pinned"]);
    const winner = result[0]?.outcome === "pinned" ? hostKey : otherHostKey;
    expect((await list(f))[0]).toMatchObject({
      generation: 2,
      learnedHostKey: winner,
    });
    const loser = winner === hostKey ? otherHostKey : hostKey;
    await expect(pin(f, 999, loser)).resolves.toStrictEqual({
      outcome: "host_key_mismatch",
    });
  });

  it("rejects stale endpoint edits and resets instead of silently repinning", async () => {
    const f = await fixture();
    authenticate(f);
    await accept(
      config().update({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
        body: { expectedGeneration: 1, host: "new.example.com" },
      }),
      [200],
    );
    await expect(pin(f, 1)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "pinned",
      generation: 3,
    });
    authenticate(f);
    await accept(
      config().resetHostKey({
        params: { connectionId: f.connectionId },
        headers: sessionHeaders,
        body: { expectedGeneration: 3 },
      }),
      [200],
    );
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    await expect(pin(f, 4)).resolves.toStrictEqual({
      outcome: "pinned",
      generation: 5,
    });
    await expect(pin(f, 2)).resolves.toStrictEqual({
      outcome: "configuration_changed",
    });
    expect((await list(f))[0]).toMatchObject({
      generation: 5,
      learnedHostKey: hostKey,
    });
  });

  it("rejects malformed or extra authority fields before sensitive work", async () => {
    const f = await fixture();
    const kms = useSecretKmsProbe();
    const raw = setupRawAppRequest({ context, routes: runnerSshRoutes });
    const base = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
    };
    for (const body of [
      { ...base, host: "attacker.example" },
      { ...base, command: "id" },
      { ...base, userId: f.userId },
      { ...base, connectionId: "not-a-uuid" },
      {
        ...base,
        runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 0 },
      },
    ]) {
      const result = await raw(`/api/runners/runs/${f.runId}/ssh/resolve`, {
        method: "POST",
        headers: { ...runnerHeaders, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(400);
    }
    const invalidPin = await raw(`/api/runners/runs/${f.runId}/ssh/pin`, {
      method: "POST",
      headers: { ...runnerHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        expectedGeneration: 1,
        observedHostKey: { algorithm: "ssh-dss", fingerprint: "bad" },
      }),
    });
    expect(invalidPin.status).toBe(400);
    expect(kms.decryptCalls).toBe(0);
    expect((await list(f))[0]?.learnedHostKey).toBeNull();
  });

  it("surfaces KMS failure and does not pin as a side effect of resolving", async () => {
    const f = await fixture();
    useSecretKmsProbe(undefined, () => {
      return Promise.reject(new Error("KMS unavailable"));
    });
    const result = await client().resolve({
      params: { runId: f.runId },
      headers: runnerHeaders,
      body: { connectionId: f.connectionId, runnerIdentity: f.runnerIdentity },
    });
    expect(result.status).toBe(500);
    expect((await list(f))[0]?.learnedHostKey).toBeNull();
  });

  it("does not hold authorization locks across KMS or pretend to claw back an in-flight handoff", async () => {
    const f = await fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    useSecretKmsProbe(undefined, (_request, call) => {
      if (call === 1) {
        entered.resolve(undefined);
        return release.promise;
      }
      return undefined;
    });
    const pending = resolve(f);
    await entered.promise;
    const finishHandoff = async () => {
      release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
      await pending;
    };
    await onRejection(
      (async () => {
        await access(f, false);
        await expect(resolve(f)).resolves.toStrictEqual({
          outcome: "unavailable",
        });
      })(),
      finishHandoff,
    );
    await finishHandoff();
    await expect(pending).resolves.toMatchObject({
      outcome: "resolved",
      privateKey,
    });
    await expect(pin(f)).resolves.toStrictEqual({ outcome: "unavailable" });
  });
});
