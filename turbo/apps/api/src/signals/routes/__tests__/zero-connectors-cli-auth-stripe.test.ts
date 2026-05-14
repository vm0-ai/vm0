import { randomUUID } from "node:crypto";

import { zeroCliAuthStripeContract } from "@vm0/api-contracts/contracts/zero-connectors-cli-auth-stripe";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
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

function client() {
  return setupApp({ context })(zeroCliAuthStripeContract);
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
  readonly commandId?: string;
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}): SandboxCommandResult {
  return {
    sandboxId: args.sandboxId ?? "sandbox_stripe_cli_auth_test",
    commandId: args.commandId ?? "cmd_stripe_cli_auth_test",
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

function startOutput(
  args: {
    readonly browserUrl?: string;
    readonly nextStep?: string;
  } = {},
) {
  return JSON.stringify({
    browser_url:
      args.browserUrl ??
      "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
    verification_code: "enjoy-enough-outwit-win",
    next_step:
      args.nextStep ??
      "stripe login --complete 'https://dashboard.stripe.com/stripecli/auth/poll-token'",
  });
}

function stripeConfig(apiKey: string) {
  return `[default]
account_id = "acct_test"
display_name = "Test Account"
test_mode_api_key = "${apiKey}"
test_mode_pub_key = "pk_test_123"
`;
}

function mockStripeCliSandbox(
  args: {
    readonly startExitCode?: number;
    readonly startBrowserUrl?: string;
    readonly startNextStep?: string;
    readonly startStderr?: string;
    readonly completeExitCode?: number;
    readonly configApiKey?: string;
  } = {},
) {
  const handle = { sandboxId: "sandbox_stripe_cli_auth_test" };
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
      return Promise.resolve(handle);
    },
    get(sandboxId) {
      return Promise.resolve({ sandboxId });
    },
    runCommand(commandHandle, options) {
      calls.run.push({ handle: commandHandle, options });
      const script = options.args?.[1] ?? "";
      if (script.includes("--non-interactive")) {
        return Promise.resolve(
          commandResult({
            sandboxId: commandHandle.sandboxId,
            exitCode: args.startExitCode ?? 0,
            stdout:
              args.startExitCode && args.startExitCode !== 0
                ? ""
                : startOutput({
                    browserUrl: args.startBrowserUrl,
                    nextStep: args.startNextStep,
                  }),
            stderr: args.startStderr,
          }),
        );
      }
      if (script.includes("--complete")) {
        return Promise.resolve(
          commandResult({
            sandboxId: commandHandle.sandboxId,
            exitCode: args.completeExitCode ?? 0,
            stdout: args.completeExitCode === 124 ? "" : "> Done\n",
          }),
        );
      }
      throw new Error(`Unexpected command script: ${script}`);
    },
    readFile(commandHandle, options) {
      calls.read.push({ handle: commandHandle, options });
      return Promise.resolve({
        status: "ok",
        data: Buffer.from(stripeConfig(args.configApiKey ?? "rk_test_123")),
        bytes: 1,
        limitBytes: 16 * 1024,
        truncated: false,
      });
    },
    updateNetworkPolicy() {
      throw new Error("updateNetworkPolicy is not used by CLI auth for Stripe");
    },
    extendTimeout() {
      throw new Error("extendTimeout is not used by CLI auth for Stripe");
    },
    stop(commandHandle, options): Promise<SandboxCleanupResult> {
      calls.stop.push({ handle: commandHandle, options });
      return Promise.resolve({ status: "stopped" });
    },
  });

  return calls;
}

async function enableCliAuthStripe(userId: string, orgId: string) {
  const db = store.set(writeDb$);
  await db
    .insert(userFeatureSwitches)
    .values({
      orgId,
      userId,
      switches: {
        [FeatureSwitchKey.CliAuth]: true,
        [FeatureSwitchKey.CliAuthStripe]: true,
      },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: {
        switches: {
          [FeatureSwitchKey.CliAuth]: true,
          [FeatureSwitchKey.CliAuthStripe]: true,
        },
      },
    });
}

async function cleanupUser(userId: string, orgId: string) {
  const db = store.set(writeDb$);
  await db
    .delete(connectors)
    .where(and(eq(connectors.userId, userId), eq(connectors.orgId, orgId)));
  await db
    .delete(secrets)
    .where(and(eq(secrets.userId, userId), eq(secrets.orgId, orgId)));
  await db
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.userId, userId),
        eq(userFeatureSwitches.orgId, orgId),
      ),
    );
}

describe("CLI auth for Stripe connector routes", () => {
  const fixtures: { readonly userId: string; readonly orgId: string }[] = [];

  afterEach(async () => {
    clearMockNow();
    clearMockSandboxClient();
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupUser(fixture.userId, fixture.orgId);
      }
    }
  });

  async function setupUser() {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    fixtures.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    await enableCliAuthStripe(userId, orgId);
    return { userId, orgId };
  }

  it("requires both CLI auth feature switches before creating a sandbox", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    fixtures.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const calls = mockStripeCliSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(calls.create).toHaveLength(0);
  });

  it("starts CLI auth for Stripe and returns browser confirmation details", async () => {
    await setupUser();
    const calls = mockStripeCliSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "stripe",
      status: "pending",
      browserUrl:
        "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
      verificationCode: "enjoy-enough-outwit-win",
      expiresIn: 600,
      interval: 5,
    });
    expect(response.body.sessionToken).not.toContain("poll-token");
    expect(calls.create[0]).toMatchObject({
      runtime: "node24",
      timeoutMs: 15 * 60 * 1000,
    });
    const startScript = calls.run[0]?.options.args?.[1] ?? "";
    expect(startScript).toContain("--non-interactive");
    expect(startScript).toContain(
      "releases/download/v1.40.9/stripe_1.40.9_linux_x86_64.tar.gz",
    );
    expect(startScript).toContain(
      "(cd /tmp && sha256sum -c stripe-cli.sha256) >&2",
    );
    expect(startScript).not.toContain("releases/latest");
    expect(calls.stop).toHaveLength(0);
  });

  it("stops the sandbox when Stripe returns an unexpected completion URL", async () => {
    await setupUser();
    const calls = mockStripeCliSandbox({
      startNextStep:
        "stripe login --complete 'https://example.test/stripecli/auth/poll-token'",
    });

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [503],
    );

    expect(response.body.error.code).toBe("CLI_AUTH_STRIPE_FAILED");
    expect(response.body.error.message).toBe(
      "Stripe CLI response included an unexpected completion URL",
    );
    expect(calls.stop).toHaveLength(1);
  });

  it("stops the sandbox when Stripe returns an unexpected browser URL", async () => {
    await setupUser();
    const calls = mockStripeCliSandbox({
      startBrowserUrl:
        "https://example.test/stripecli/confirm_auth?t=start-token",
    });

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [503],
    );

    expect(response.body.error.code).toBe("CLI_AUTH_STRIPE_FAILED");
    expect(response.body.error.message).toBe(
      "Stripe CLI response included an unexpected browser URL",
    );
    expect(calls.stop).toHaveLength(1);
  });

  it("redacts secrets from failed Stripe CLI command output", async () => {
    await setupUser();
    mockStripeCliSandbox({
      startExitCode: 1,
      startStderr:
        "failed STRIPE_SECRET=sk_test_should_not_leak https://dashboard.stripe.com/stripecli/auth/poll-token",
    });

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [503],
    );

    expect(response.body.error.message).toContain("STRIPE_SECRET=[redacted]");
    expect(response.body.error.message).toContain(
      "https://dashboard.stripe.com/stripecli/[redacted]",
    );
    expect(response.body.error.message).not.toContain(
      "sk_test_should_not_leak",
    );
    expect(response.body.error.message).not.toContain("poll-token");
  });

  it("completes CLI auth for Stripe, stores STRIPE_TOKEN, and stops the sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
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

    expect(complete.body.status).toBe("complete");
    if (complete.body.status === "complete") {
      expect(complete.body.connector).toMatchObject({
        type: "stripe",
        authMethod: "api-token",
      });
    }
    expect(calls.run[1]?.options.env).toStrictEqual({
      STRIPE_POLL_URL: "https://dashboard.stripe.com/stripecli/auth/poll-token",
    });
    expect(calls.read[0]?.options.path).toBe(
      "/vercel/sandbox/cli-auth/stripe/config/stripe/config.toml",
    );
    expect(calls.stop).toHaveLength(1);

    const db = store.set(writeDb$);
    const [secret] = await db
      .select({
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
        type: secrets.type,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.name, "STRIPE_TOKEN"),
        ),
      );
    expect(secret).toMatchObject({
      description: "Stripe CLI test mode restricted key",
      type: "user",
    });
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("rk_test_imported");
  });

  it("replaces existing Stripe OAuth local state while importing STRIPE_TOKEN", async () => {
    const { userId, orgId } = await setupUser();
    const db = store.set(writeDb$);
    await db.insert(connectors).values({
      orgId,
      userId,
      type: "stripe",
      authMethod: "oauth",
      externalId: "acct_existing",
      externalUsername: null,
      externalEmail: null,
      oauthScopes: JSON.stringify(["read_write"]),
    });
    await db.insert(secrets).values([
      {
        orgId,
        userId,
        name: "STRIPE_ACCESS_TOKEN",
        encryptedValue: "encrypted-access",
        type: "connector",
      },
      {
        orgId,
        userId,
        name: "STRIPE_REFRESH_TOKEN",
        encryptedValue: "encrypted-refresh",
        type: "connector",
      },
    ]);
    mockStripeCliSandbox({ configApiKey: "sk_test_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
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

    expect(complete.body.status).toBe("complete");
    const connectorRows = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, orgId),
          eq(connectors.userId, userId),
          eq(connectors.type, "stripe"),
        ),
      );
    const connectorSecretRows = await db
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.type, "connector"),
          inArray(secrets.name, [
            "STRIPE_ACCESS_TOKEN",
            "STRIPE_REFRESH_TOKEN",
          ]),
        ),
      );
    const [secret] = await db
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.name, "STRIPE_TOKEN"),
          eq(secrets.type, "user"),
        ),
      );

    expect(connectorRows).toStrictEqual([]);
    expect(connectorSecretRows).toStrictEqual([]);
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("sk_test_imported");
  });

  it("rejects live mode Stripe keys and stops the sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_live_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [503],
    );

    expect(complete.body.error.code).toBe("CLI_AUTH_STRIPE_FAILED");
    expect(complete.body.error.message).toBe(
      "Stripe CLI config did not contain a test mode API key",
    );
    expect(calls.stop).toHaveLength(1);

    const secretRows = await store
      .set(writeDb$)
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.name, "STRIPE_TOKEN"),
        ),
      );
    expect(secretRows).toStrictEqual([]);
  });

  it("returns pending and keeps the sandbox alive when browser auth is not approved yet", async () => {
    await setupUser();
    const calls = mockStripeCliSandbox({ completeExitCode: 124 });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
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

    expect(complete.body).toStrictEqual({
      status: "pending",
      errorMessage: null,
    });
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(0);
  });

  it("rejects invalid completion tokens", async () => {
    await setupUser();
    const calls = mockStripeCliSandbox();

    const response = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: "not-a-session-token" },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(calls.run).toHaveLength(0);
  });

  it("rejects expired completion tokens and stops the sandbox", async () => {
    await setupUser();
    const calls = mockStripeCliSandbox();
    const createdAt = new Date("2026-05-14T00:00:00.000Z");
    mockNow(createdAt);

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    mockNow(new Date(createdAt.getTime() + 11 * 60 * 1000));
    const response = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(calls.run).toHaveLength(1);
    expect(calls.stop).toHaveLength(1);
  });

  it("rejects completion tokens from a different user", async () => {
    const { orgId } = await setupUser();
    const calls = mockStripeCliSandbox();

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [200],
    );

    const otherUserId = `user_${randomUUID()}`;
    fixtures.push({ userId: otherUserId, orgId });
    mocks.clerk.session(otherUserId, orgId);
    await enableCliAuthStripe(otherUserId, orgId);

    const response = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(calls.run).toHaveLength(1);
    expect(calls.stop).toHaveLength(0);
  });
});
