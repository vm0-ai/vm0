import { randomUUID } from "node:crypto";

import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import {
  clearMockSandboxClient,
  emptyBoundedTextOutput,
  mockSandboxClient,
  type BoundedTextOutput,
  type CreateSandboxOptions,
  type ReadSandboxFileOptions,
  type RunSandboxCommandOptions,
  type SandboxCleanupResult,
  type SandboxCommandResult,
  type SandboxHandle,
  type StopSandboxOptions,
} from "../../external/sandbox";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ORG_SENTINEL_USER_ID = "__org__";

function client() {
  return setupApp({ context })(zeroCodexDeviceAuthContract);
}

function textOutput(text: string): BoundedTextOutput {
  return {
    text,
    bytes: Buffer.byteLength(text),
    limitBytes: 16 * 1024,
    truncated: false,
  };
}

function commandResult(args: {
  readonly sandboxId?: string;
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}): SandboxCommandResult {
  return {
    sandboxId: args.sandboxId ?? "sandbox_codex_device_auth_test",
    commandId: "cmd_codex_device_auth_test",
    detached: false,
    exitCode: args.exitCode,
    stdout:
      args.stdout === undefined
        ? emptyBoundedTextOutput(16 * 1024)
        : textOutput(args.stdout),
    stderr:
      args.stderr === undefined
        ? emptyBoundedTextOutput(16 * 1024)
        : textOutput(args.stderr),
  };
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function makeIdToken(opts: {
  readonly accountId: string;
  readonly planType: string;
  readonly workspaceName: string;
}): string {
  return makeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.accountId,
      chatgpt_plan_type: opts.planType,
      organization: { title: opts.workspaceName },
    },
    exp: Math.floor(now() / 1000) + 3600,
  });
}

function makeAuthJson(scope: "org" | "personal"): string {
  const accessExp = Math.floor(now() / 1000) + 7200;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: makeJwt({ exp: accessExp }),
      refresh_token: `rt_${scope}_synthetic_high_entropy`,
      account_id: "ws_acct_plain",
      id_token: makeIdToken({
        accountId: `ws_acct_from_id_token_${scope}`,
        planType: "plus",
        workspaceName: scope === "org" ? "Org Acme" : "Personal Acme",
      }),
    },
  });
}

function mockCodexDeviceAuthSandbox(
  args: {
    readonly authJsonScope?: "org" | "personal";
    readonly output?: string;
  } = {},
) {
  const calls = {
    create: [] as CreateSandboxOptions[],
    run: [] as {
      readonly handle: SandboxHandle;
      readonly options: RunSandboxCommandOptions;
    }[],
    read: [] as {
      readonly handle: SandboxHandle;
      readonly options: ReadSandboxFileOptions;
    }[],
    stop: [] as {
      readonly handle: SandboxHandle;
      readonly options: StopSandboxOptions | undefined;
    }[],
  };

  mockSandboxClient({
    create(options = {}) {
      calls.create.push(options);
      return Promise.resolve({ sandboxId: "sandbox_codex_device_auth_test" });
    },
    get(sandboxId) {
      return Promise.resolve({ sandboxId });
    },
    runCommand(handle, options) {
      calls.run.push({ handle, options });
      return Promise.resolve(
        commandResult({
          sandboxId: handle.sandboxId,
          exitCode: 0,
        }),
      );
    },
    readFile(handle, options) {
      calls.read.push({ handle, options });
      if (options.path.endsWith("login-output.txt")) {
        return Promise.resolve({
          status: "ok",
          data: Buffer.from(
            args.output ??
              "Open https://auth.openai.com/codex/device and enter ABCD-EFGH",
          ),
          bytes: 64,
          limitBytes: 16 * 1024,
          truncated: false,
        });
      }
      if (options.path.endsWith("login-status.txt")) {
        return Promise.resolve({ status: "missing" });
      }
      if (options.path.endsWith("auth.json")) {
        return Promise.resolve({
          status: "ok",
          data: Buffer.from(makeAuthJson(args.authJsonScope ?? "org")),
          bytes: 512,
          limitBytes: 16 * 1024,
          truncated: false,
        });
      }
      return Promise.resolve({ status: "missing" });
    },
    updateNetworkPolicy() {
      throw new Error("updateNetworkPolicy is not used by Codex device auth");
    },
    extendTimeout() {
      throw new Error("extendTimeout is not used by Codex device auth");
    },
    stop(handle, options): Promise<SandboxCleanupResult> {
      calls.stop.push({ handle, options });
      return Promise.resolve({ status: "stopped" });
    },
  });

  return calls;
}

async function enableCodexDeviceAuth(userId: string, orgId: string) {
  const db = store.set(writeDb$);
  await db
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: {
        [FeatureSwitchKey.CodexDeviceAuth]: true,
      },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: {
        switches: {
          [FeatureSwitchKey.CodexDeviceAuth]: true,
        },
      },
    });
}

async function cleanupUser(userId: string, orgId: string) {
  const db = store.set(writeDb$);
  await db
    .delete(connectorCliAuthSessions)
    .where(
      and(
        eq(connectorCliAuthSessions.userId, userId),
        eq(connectorCliAuthSessions.orgId, orgId),
      ),
    );
  await db
    .delete(modelProviders)
    .where(
      and(eq(modelProviders.orgId, orgId), eq(modelProviders.userId, userId)),
    );
  await db
    .delete(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
      ),
    );
  await db
    .delete(secrets)
    .where(and(eq(secrets.userId, userId), eq(secrets.orgId, orgId)));
  await db
    .delete(secrets)
    .where(
      and(eq(secrets.userId, ORG_SENTINEL_USER_ID), eq(secrets.orgId, orgId)),
    );
  await db
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.userId, userId),
        eq(userFeatureSwitches.orgId, orgId),
      ),
    );
}

function codexDeviceAuthSessions(userId: string, orgId: string) {
  return store
    .set(writeDb$)
    .select()
    .from(connectorCliAuthSessions)
    .where(
      and(
        eq(connectorCliAuthSessions.userId, userId),
        eq(connectorCliAuthSessions.orgId, orgId),
        eq(connectorCliAuthSessions.connectorType, "codex-oauth-token"),
        eq(connectorCliAuthSessions.source, "codex-device-auth"),
      ),
    );
}

async function chatgptSecret(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}) {
  const [secret] = await store
    .set(writeDb$)
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
        eq(secrets.type, "model-provider"),
      ),
    )
    .limit(1);
  return secret ? decryptSecretValue(secret.encryptedValue) : null;
}

describe("Codex device auth routes", () => {
  const fixtures: { readonly userId: string; readonly orgId: string }[] = [];

  afterEach(async () => {
    clearMockSandboxClient();
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupUser(fixture.userId, fixture.orgId);
      }
    }
  });

  async function setupUser(role: "org:admin" | "org:member" = "org:admin") {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    fixtures.push({ userId, orgId });
    mocks.clerk.session(userId, orgId, role);
    await enableCodexDeviceAuth(userId, orgId);
    return { userId, orgId };
  }

  it("requires the Codex device auth feature switch before creating a sandbox", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    fixtures.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const calls = mockCodexDeviceAuthSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(calls.create).toHaveLength(0);
  });

  it("rejects member org-scope starts before creating a sandbox", async () => {
    const { userId, orgId } = await setupUser("org:member");
    const calls = mockCodexDeviceAuthSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    await expect(codexDeviceAuthSessions(userId, orgId)).resolves.toStrictEqual(
      [],
    );
    expect(calls.create).toHaveLength(0);
  });

  it("starts Codex device auth and returns browser confirmation details", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockCodexDeviceAuthSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      interval: 5,
    });
    expect(response.body.sessionToken).not.toContain(
      "sandbox_codex_device_auth_test",
    );
    expect(calls.create[0]).toMatchObject({
      runtime: "node24",
      timeoutMs: 20 * 60 * 1000,
    });
    const startScript = calls.run[0]?.options.args?.[1] ?? "";
    expect(startScript).toContain("@openai/codex@0.131.0");
    expect(startScript).toContain("login --device-auth");

    const sessions = await codexDeviceAuthSessions(userId, orgId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      connectorType: "codex-oauth-token",
      source: "codex-device-auth",
      status: "awaiting_user_approval",
      sandboxId: "sandbox_codex_device_auth_test",
      approvalUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      errorMessage: null,
    });
    expect(sessions[0]?.encryptedProviderState).toBeTruthy();
  });

  it("completes org-scope device auth and imports ChatGPT secrets", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockCodexDeviceAuthSandbox({ authJsonScope: "org" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "org" },
      }),
      [200],
    );
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(complete.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Org Acme",
        planType: "plus",
      },
    });
    await expect(
      chatgptSecret({
        orgId,
        userId: ORG_SENTINEL_USER_ID,
        name: "CHATGPT_REFRESH_TOKEN",
      }),
    ).resolves.toBe("rt_org_synthetic_high_entropy");
    expect(calls.stop).toHaveLength(1);

    const sessions = await codexDeviceAuthSessions(userId, orgId);
    expect(sessions[0]?.status).toBe("imported");
  });

  it("completes personal-scope device auth for non-admin members", async () => {
    const { userId, orgId } = await setupUser("org:member");
    const calls = mockCodexDeviceAuthSandbox({ authJsonScope: "personal" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { scope: "personal" },
      }),
      [200],
    );
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(complete.body).toMatchObject({
      status: "complete",
      provider: {
        type: "codex-oauth-token",
        workspaceName: "Personal Acme",
      },
    });
    await expect(
      chatgptSecret({
        orgId,
        userId,
        name: "CHATGPT_REFRESH_TOKEN",
      }),
    ).resolves.toBe("rt_personal_synthetic_high_entropy");
    expect(calls.stop).toHaveLength(1);
  });
});
