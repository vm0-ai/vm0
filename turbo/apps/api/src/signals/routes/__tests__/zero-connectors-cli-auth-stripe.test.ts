import { randomUUID } from "node:crypto";

import { zeroConnectorsByTypeContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroCliAuthStripeContract } from "@vm0/api-contracts/contracts/zero-connectors-cli-auth-stripe";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
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
import { driveCliAuthStripeCompletion$ } from "../../services/cli-auth-stripe.service";
import { upsertOAuthConnector$ } from "../../services/zero-connector-data.service";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function client() {
  return setupApp({ context })(zeroCliAuthStripeContract);
}

function zeroSecretsClient() {
  return setupApp({ context })(zeroSecretsContract);
}

function zeroSecretByNameClient() {
  return setupApp({ context })(zeroSecretsByNameContract);
}

function zeroConnectorsByTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
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

type CommandResultInput =
  | SandboxCommandResult
  | Promise<SandboxCommandResult>
  | (() => SandboxCommandResult | Promise<SandboxCommandResult>);

function resolveCommandResult(input: CommandResultInput) {
  return typeof input === "function" ? input() : input;
}

function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred } as const;
}

function startOutput(
  args: {
    readonly browserUrl?: string;
    readonly nextStep?: string;
    readonly verificationCode?: string;
  } = {},
) {
  return JSON.stringify({
    browser_url:
      args.browserUrl ??
      "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
    verification_code: args.verificationCode ?? "enjoy-enough-outwit-win",
    next_step:
      args.nextStep ??
      "stripe login --complete 'https://dashboard.stripe.com/stripecli/auth/poll-token'",
  });
}

function stripeConfig(apiKey: string) {
  const keyName = apiKey.includes("_live_")
    ? "live_mode_api_key"
    : "test_mode_api_key";
  return `[default]
account_id = "acct_test"
display_name = "Test Account"
${keyName} = "${apiKey}"
test_mode_pub_key = "pk_test_123"
`;
}

function mockStripeCliSandbox(
  args: {
    readonly startExitCode?: number;
    readonly startBrowserUrl?: string;
    readonly startNextStep?: string;
    readonly startVerificationCode?: string;
    readonly startStderr?: string;
    readonly startResults?: readonly CommandResultInput[];
    readonly completeExitCode?: number;
    readonly completeResults?: readonly CommandResultInput[];
    readonly configApiKey?: string;
  } = {},
) {
  const firstSandboxId = "sandbox_stripe_cli_auth_test";
  let createdSandboxCount = 0;
  const startResults = [...(args.startResults ?? [])];
  const completeResults = [...(args.completeResults ?? [])];
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
      const sandboxId =
        createdSandboxCount === 0
          ? firstSandboxId
          : `${firstSandboxId}_${String(createdSandboxCount + 1)}`;
      createdSandboxCount += 1;
      return Promise.resolve({ sandboxId });
    },
    get(sandboxId) {
      return Promise.resolve({ sandboxId });
    },
    runCommand(commandHandle, options) {
      calls.run.push({ handle: commandHandle, options });
      const script = options.args?.[1] ?? "";
      if (script.includes("--non-interactive")) {
        const startResult = startResults.shift();
        if (startResult) {
          return Promise.resolve(resolveCommandResult(startResult));
        }
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
                    verificationCode: args.startVerificationCode,
                  }),
            stderr: args.startStderr,
          }),
        );
      }
      if (script.includes("--complete")) {
        const completeResult = completeResults.shift();
        if (completeResult) {
          return Promise.resolve(resolveCommandResult(completeResult));
        }
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
        [FeatureSwitchKey.CliAuthStripe]: true,
      },
    })
    .onConflictDoUpdate({
      target: [userFeatureSwitches.orgId, userFeatureSwitches.userId],
      set: {
        switches: {
          [FeatureSwitchKey.CliAuthStripe]: true,
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

function cliAuthStripeSessions(userId: string, orgId: string) {
  return store
    .set(writeDb$)
    .select()
    .from(connectorCliAuthSessions)
    .where(
      and(
        eq(connectorCliAuthSessions.userId, userId),
        eq(connectorCliAuthSessions.orgId, orgId),
        eq(connectorCliAuthSessions.connectorType, "stripe"),
        eq(connectorCliAuthSessions.source, "stripe-cli"),
      ),
    );
}

async function onlyCliAuthStripeSession(userId: string, orgId: string) {
  const rows = await cliAuthStripeSessions(userId, orgId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function stripeTokenSecret(userId: string, orgId: string) {
  const [secret] = await store
    .set(writeDb$)
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
        eq(secrets.type, "user"),
      ),
    )
    .limit(1);
  return secret ?? null;
}

async function stripeConnector(userId: string, orgId: string) {
  const [connector] = await store
    .set(writeDb$)
    .select({
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, "stripe"),
      ),
    )
    .limit(1);
  return connector ?? null;
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

  it("requires the Stripe CLI auth feature switch before creating a sandbox", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    fixtures.push({ userId, orgId });
    mocks.clerk.session(userId, orgId);
    const calls = mockStripeCliSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "invalid" } as never,
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(calls.create).toHaveLength(0);
  });

  it("rejects missing mode before creating a session or sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: {} as never,
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    await expect(cliAuthStripeSessions(userId, orgId)).resolves.toStrictEqual(
      [],
    );
    expect(calls.create).toHaveLength(0);
  });

  it("rejects invalid mode before creating a session or sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "invalid" } as never,
      }),
      [400],
    );

    expect(response.body.error.code).toBe("BAD_REQUEST");
    await expect(cliAuthStripeSessions(userId, orgId)).resolves.toStrictEqual(
      [],
    );
    expect(calls.create).toHaveLength(0);
  });

  it("starts CLI auth for Stripe and returns browser confirmation details", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "stripe",
      status: "pending",
      mode: "test",
      browserUrl:
        "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
      verificationCode: "enjoy-enough-outwit-win",
      expiresIn: 600,
      interval: 5,
    });
    expect(response.body.sessionToken).not.toContain("poll-token");
    expect(response.body.sessionToken).not.toContain(
      "sandbox_stripe_cli_auth_test",
    );
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

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session).toMatchObject({
      connectorType: "stripe",
      source: "stripe-cli",
      status: "awaiting_user_approval",
      sandboxId: "sandbox_stripe_cli_auth_test",
      approvalUrl:
        "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
      verificationCode: "enjoy-enough-outwit-win",
      errorMessage: null,
    });
    expect(session.encryptedProviderState).toBeTruthy();
    expect(session.encryptedProviderState).not.toContain("poll-token");
  });

  it("reuses an active same-mode CLI auth session instead of starting another sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();

    const firstStart = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    const secondStart = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    expect(secondStart.body).toMatchObject({
      type: "stripe",
      status: "pending",
      mode: "test",
      browserUrl: firstStart.body.browserUrl,
      verificationCode: firstStart.body.verificationCode,
    });
    expect(calls.create).toHaveLength(1);
    expect(calls.run).toHaveLength(1);
    expect(calls.stop).toHaveLength(0);

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session.status).toBe("awaiting_user_approval");
  });

  it("does not start another sandbox while the first start is still initializing", async () => {
    const { userId, orgId } = await setupUser();
    const startCommandStarted = deferred<void>();
    const startCommandResult = deferred<SandboxCommandResult>();
    const calls = mockStripeCliSandbox({
      startResults: [
        () => {
          startCommandStarted.resolve();
          return startCommandResult.promise;
        },
      ],
    });

    const firstStart = accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    await startCommandStarted.promise;

    const secondStart = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [503],
    );

    expect(secondStart.body.error.code).toBe("CLI_AUTH_STRIPE_UNAVAILABLE");
    expect(secondStart.body.error.message).toBe(
      "CLI auth for Stripe session is already starting",
    );
    startCommandResult.resolve(
      commandResult({ exitCode: 0, stdout: startOutput() }),
    );
    await firstStart;

    expect(calls.create).toHaveLength(1);
    expect(calls.run).toHaveLength(1);
    expect(calls.stop).toHaveLength(0);

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session.status).toBe("awaiting_user_approval");
  });

  it("supersedes an active CLI auth session when the requested mode changes", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();

    await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    const liveStart = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "live" },
      }),
      [200],
    );

    expect(liveStart.body.mode).toBe("live");
    expect(calls.create).toHaveLength(2);
    expect(calls.run).toHaveLength(2);
    expect(calls.stop).toHaveLength(1);

    const sessions = await cliAuthStripeSessions(userId, orgId);
    expect(sessions).toHaveLength(2);
    const cancelled = sessions.find((session) => {
      return session.status === "cancelled";
    });
    const active = sessions.find((session) => {
      return session.status === "awaiting_user_approval";
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      errorMessage: "CLI auth for Stripe session was superseded",
    });
    expect(cancelled?.approvalUrl).toBeNull();
    expect(cancelled?.verificationCode).toBeNull();
    expect(cancelled?.encryptedProviderState).toBeNull();
    expect(active).toMatchObject({
      status: "awaiting_user_approval",
      sandboxId: "sandbox_stripe_cli_auth_test_2",
    });
  });

  it("stops the sandbox when Stripe returns an unexpected completion URL", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({
      startNextStep:
        "stripe login --complete 'https://example.test/stripecli/auth/poll-token'",
    });

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [503],
    );

    expect(response.body.error.code).toBe("CLI_AUTH_STRIPE_FAILED");
    expect(response.body.error.message).toBe(
      "Stripe CLI response included an unexpected completion URL",
    );
    expect(calls.stop).toHaveLength(1);

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session).toMatchObject({
      status: "error",
      sandboxId: "sandbox_stripe_cli_auth_test",
      errorMessage: "Stripe CLI response included an unexpected completion URL",
    });
  });

  it("stops the sandbox when Stripe returns an unexpected browser URL", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({
      startBrowserUrl:
        "https://example.test/stripecli/confirm_auth?t=start-token",
    });

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [503],
    );

    expect(response.body.error.code).toBe("CLI_AUTH_STRIPE_FAILED");
    expect(response.body.error.message).toBe(
      "Stripe CLI response included an unexpected browser URL",
    );
    expect(calls.stop).toHaveLength(1);

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session).toMatchObject({
      status: "error",
      sandboxId: "sandbox_stripe_cli_auth_test",
      errorMessage: "Stripe CLI response included an unexpected browser URL",
    });
  });

  it("stops the sandbox when persisting the started session fails", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({
      startVerificationCode: "x".repeat(129),
    });

    await expect(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
    ).rejects.toThrow();

    expect(calls.stop).toHaveLength(1);
    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session).toMatchObject({
      status: "initializing",
      sandboxId: "sandbox_stripe_cli_auth_test",
    });
  });

  it("redacts secrets from failed Stripe CLI command output", async () => {
    const { userId, orgId } = await setupUser();
    mockStripeCliSandbox({
      startExitCode: 1,
      startStderr:
        "failed STRIPE_SECRET=sk_test_should_not_leak https://dashboard.stripe.com/stripecli/auth/poll-token",
    });

    const response = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
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

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session.status).toBe("error");
    expect(session.errorMessage).toContain("STRIPE_SECRET=[redacted]");
    expect(session.errorMessage).not.toContain("sk_test_should_not_leak");
    expect(session.errorMessage).not.toContain("poll-token");
  });

  it("completes CLI auth for Stripe, stores STRIPE_TOKEN, and stops the sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_imported" });
    getApiTestMocks().ably.publish.mockRejectedValueOnce(
      new Error("Ably publish failed"),
    );

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
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
    expect(getApiTestMocks().ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      null,
    );

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
      description: "Stripe CLI test mode API key",
      type: "user",
    });
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("rk_test_imported");

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session.status).toBe("imported");
    expect(session.completedAt).toBeInstanceOf(Date);
    expect(session.errorMessage).toBeNull();
    expect(session.approvalUrl).toBeNull();
    expect(session.verificationCode).toBeNull();
    expect(session.encryptedProviderState).toBeNull();
  });

  it("keeps a stale CLI auth completion from overwriting a manually set STRIPE_TOKEN", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_stale" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    await accept(
      zeroSecretsClient().set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "STRIPE_TOKEN",
          value: "rk_test_manual",
          description: "Manual Stripe token",
        },
      }),
      [200],
    );

    expect(calls.stop).toHaveLength(1);
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [400],
    );

    expect(complete.body.error.message).toBe(
      "CLI auth for Stripe session is not active",
    );
    expect(calls.run).toHaveLength(1);
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(1);

    const secret = await stripeTokenSecret(userId, orgId);
    expect(secret).toMatchObject({
      description: "Manual Stripe token",
      type: "user",
    });
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("rk_test_manual");

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session).toMatchObject({
      status: "cancelled",
      errorMessage:
        "CLI auth for Stripe session was cancelled because Stripe credentials changed",
    });
    expect(session.approvalUrl).toBeNull();
    expect(session.verificationCode).toBeNull();
    expect(session.encryptedProviderState).toBeNull();
  });

  it("keeps a stale CLI auth completion from recreating a deleted STRIPE_TOKEN", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_stale" });

    await accept(
      zeroSecretsClient().set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "STRIPE_TOKEN",
          value: "rk_test_existing",
        },
      }),
      [200],
    );
    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    await accept(
      zeroSecretByNameClient().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { name: "STRIPE_TOKEN" },
      }),
      [204],
    );

    expect(calls.stop).toHaveLength(1);
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [400],
    );

    expect(complete.body.error.message).toBe(
      "CLI auth for Stripe session is not active",
    );
    await expect(stripeTokenSecret(userId, orgId)).resolves.toBeNull();
    expect(calls.run).toHaveLength(1);
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(1);
  });

  it("keeps a stale CLI auth completion from recreating STRIPE_TOKEN after connector disconnect", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_stale" });

    await accept(
      zeroSecretsClient().set({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          name: "STRIPE_TOKEN",
          value: "rk_test_existing",
        },
      }),
      [200],
    );
    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    await accept(
      zeroConnectorsByTypeClient().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "stripe" },
      }),
      [204],
    );

    expect(calls.stop).toHaveLength(1);
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [400],
    );

    expect(complete.body.error.message).toBe(
      "CLI auth for Stripe session is not active",
    );
    await expect(stripeTokenSecret(userId, orgId)).resolves.toBeNull();
    expect(calls.run).toHaveLength(1);
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(1);
  });

  it("does not cancel pending CLI auth when deleting a missing connector", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    await accept(
      zeroConnectorsByTypeClient().delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "stripe" },
      }),
      [404],
    );

    expect(calls.stop).toHaveLength(0);
    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session.status).toBe("awaiting_user_approval");

    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(complete.body.status).toBe("complete");
    expect(calls.run).toHaveLength(2);
    expect(calls.read).toHaveLength(1);
    expect(calls.stop).toHaveLength(1);
    const secret = await stripeTokenSecret(userId, orgId);
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("rk_test_imported");
  });

  it("keeps a stale CLI auth completion from replacing a Stripe OAuth reconnect", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_stale" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    await store.set(
      upsertOAuthConnector$,
      {
        orgId,
        userId,
        type: "stripe",
        accessToken: "oauth_access",
        userInfo: {
          id: "acct_oauth",
          username: null,
          email: null,
        },
        oauthScopes: ["read_write"],
      },
      context.signal,
    );

    expect(calls.stop).toHaveLength(1);
    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [400],
    );

    expect(complete.body.error.message).toBe(
      "CLI auth for Stripe session is not active",
    );
    await expect(stripeConnector(userId, orgId)).resolves.toStrictEqual({
      authMethod: "oauth",
      externalId: "acct_oauth",
    });
    await expect(stripeTokenSecret(userId, orgId)).resolves.toBeNull();
    expect(calls.run).toHaveLength(1);
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(1);
  });

  it("removes STRIPE_TOKEN when Stripe OAuth reconnect wins after CLI auth imported", async () => {
    const { userId, orgId } = await setupUser();
    mockStripeCliSandbox({ configApiKey: "rk_test_stale" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );
    await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );
    await expect(stripeTokenSecret(userId, orgId)).resolves.not.toBeNull();

    await store.set(
      upsertOAuthConnector$,
      {
        orgId,
        userId,
        type: "stripe",
        accessToken: "oauth_access",
        userInfo: {
          id: "acct_oauth",
          username: null,
          email: null,
        },
        oauthScopes: ["read_write"],
      },
      context.signal,
    );

    await expect(stripeConnector(userId, orgId)).resolves.toStrictEqual({
      authMethod: "oauth",
      externalId: "acct_oauth",
    });
    await expect(stripeTokenSecret(userId, orgId)).resolves.toBeNull();
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
        body: { mode: "test" },
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

  it("rejects live mode Stripe keys for a test-mode session and stops the sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_live_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
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

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session).toMatchObject({
      status: "error",
      errorMessage: "Stripe CLI config did not contain a test mode API key",
    });

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

  it("completes live-mode CLI auth with a restricted live key", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_live_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "live" },
      }),
      [200],
    );
    expect(start.body.mode).toBe("live");

    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(complete.body.status).toBe("complete");
    expect(calls.stop).toHaveLength(1);

    const [secret] = await store
      .set(writeDb$)
      .select({
        encryptedValue: secrets.encryptedValue,
        description: secrets.description,
      })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, orgId),
          eq(secrets.userId, userId),
          eq(secrets.name, "STRIPE_TOKEN"),
          eq(secrets.type, "user"),
        ),
      );
    expect(secret).toMatchObject({
      description: "Stripe CLI live mode API key",
    });
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("rk_live_imported");
  });

  it("completes live-mode CLI auth with a secret live key", async () => {
    const { userId, orgId } = await setupUser();
    mockStripeCliSandbox({ configApiKey: "sk_live_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "live" },
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

    const [secret] = await store
      .set(writeDb$)
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
    expect(decryptSecretValue(secret!.encryptedValue)).toBe("sk_live_imported");
  });

  it("rejects test mode Stripe keys for a live-mode session and stops the sandbox", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "live" },
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
      "Stripe CLI config did not contain a live mode API key",
    );
    expect(calls.stop).toHaveLength(1);

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session).toMatchObject({
      status: "error",
      errorMessage: "Stripe CLI config did not contain a live mode API key",
    });
  });

  it("returns pending and keeps the sandbox alive when browser auth is not approved yet", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ completeExitCode: 124 });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
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

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session.status).toBe("awaiting_user_approval");
    expect(session.completedAt).toBeNull();
  });

  it("returns pending without rerunning completion while another runner owns the session", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();
    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    const session = await onlyCliAuthStripeSession(userId, orgId);
    await store
      .set(writeDb$)
      .update(connectorCliAuthSessions)
      .set({
        status: "completing",
        updatedAt: nowDate(),
      })
      .where(eq(connectorCliAuthSessions.id, session.id));

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
    expect(calls.run).toHaveLength(1);
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(0);
  });

  it("does not expire a fresh completing session while another runner owns it", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();
    const createdAt = new Date("2026-05-14T00:00:00.000Z");
    mockNow(createdAt);
    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    mockNow(new Date(createdAt.getTime() + 11 * 60 * 1000));
    const session = await onlyCliAuthStripeSession(userId, orgId);
    await store
      .set(writeDb$)
      .update(connectorCliAuthSessions)
      .set({
        status: "completing",
        updatedAt: nowDate(),
      })
      .where(eq(connectorCliAuthSessions.id, session.id));

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
    expect(calls.run).toHaveLength(1);
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(0);

    const completingSession = await onlyCliAuthStripeSession(userId, orgId);
    expect(completingSession.status).toBe("completing");
  });

  it("expires a stale completing session after the session ttl", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();
    const createdAt = new Date("2026-05-14T00:00:00.000Z");
    mockNow(createdAt);
    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    mockNow(new Date(createdAt.getTime() + 11 * 60 * 1000));
    const session = await onlyCliAuthStripeSession(userId, orgId);
    await store
      .set(writeDb$)
      .update(connectorCliAuthSessions)
      .set({
        status: "completing",
        updatedAt: new Date(createdAt.getTime() + 8 * 60 * 1000),
      })
      .where(eq(connectorCliAuthSessions.id, session.id));

    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [400],
    );

    expect(complete.body.error.code).toBe("BAD_REQUEST");
    expect(calls.run).toHaveLength(1);
    expect(calls.read).toHaveLength(0);
    expect(calls.stop).toHaveLength(1);

    const expiredSession = await onlyCliAuthStripeSession(userId, orgId);
    expect(expiredSession.status).toBe("expired");
  });

  it("recovers a stale completing session and finishes import", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_recovered" });
    const now = new Date("2026-05-14T00:00:00.000Z");
    mockNow(now);
    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    const session = await onlyCliAuthStripeSession(userId, orgId);
    await store
      .set(writeDb$)
      .update(connectorCliAuthSessions)
      .set({
        status: "completing",
        updatedAt: new Date(now.getTime() - 5 * 60 * 1000),
      })
      .where(eq(connectorCliAuthSessions.id, session.id));

    const complete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );

    expect(complete.body.status).toBe("complete");
    expect(calls.run).toHaveLength(2);
    expect(calls.read).toHaveLength(1);
    expect(calls.stop).toHaveLength(1);

    const recoveredSession = await onlyCliAuthStripeSession(userId, orgId);
    expect(recoveredSession.status).toBe("imported");
  });

  it("keeps a superseded runner from overwriting a recovered session", async () => {
    const { userId, orgId } = await setupUser();
    const firstCompleteStarted = deferred<void>();
    const firstCompleteResult = deferred<SandboxCommandResult>();
    const calls = mockStripeCliSandbox({
      configApiKey: "rk_test_recovered",
      completeResults: [
        () => {
          firstCompleteStarted.resolve();
          return firstCompleteResult.promise;
        },
        commandResult({ exitCode: 0, stdout: "> Done\n" }),
      ],
    });
    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    const firstComplete = accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );
    await firstCompleteStarted.promise;

    const claimedSession = await onlyCliAuthStripeSession(userId, orgId);
    expect(claimedSession.status).toBe("completing");
    mockNow(new Date(claimedSession.updatedAt.getTime() + 5 * 60 * 1000));

    const secondComplete = await accept(
      client().complete({
        headers: { authorization: "Bearer clerk-session" },
        body: { sessionToken: start.body.sessionToken },
      }),
      [200],
    );
    expect(secondComplete.body.status).toBe("complete");

    firstCompleteResult.resolve(
      commandResult({
        exitCode: 1,
        stderr: "old runner completed after the claim was superseded",
      }),
    );
    const firstCompleteResponse = await firstComplete;

    expect(firstCompleteResponse.body).toStrictEqual({
      status: "pending",
      errorMessage: null,
    });
    expect(calls.run).toHaveLength(3);
    expect(calls.read).toHaveLength(1);
    expect(calls.stop).toHaveLength(1);

    const recoveredSession = await onlyCliAuthStripeSession(userId, orgId);
    expect(recoveredSession.status).toBe("imported");
    expect(recoveredSession.errorMessage).toBeNull();
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
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox();
    const createdAt = new Date("2026-05-14T00:00:00.000Z");
    mockNow(createdAt);

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
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

    const session = await onlyCliAuthStripeSession(userId, orgId);
    expect(session.status).toBe("expired");
  });

  it("rejects completion tokens from a different user", async () => {
    const { orgId } = await setupUser();
    const calls = mockStripeCliSandbox();

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
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

  it("drives completion server-side until the sandbox terminal status", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ configApiKey: "rk_test_imported" });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    await store.set(
      driveCliAuthStripeCompletion$,
      {
        orgId,
        userId,
        sessionToken: start.body.sessionToken,
      },
      AbortSignal.timeout(30_000),
    );

    // Driver runs one complete iteration after start, hits terminal, stops.
    expect(calls.run).toHaveLength(2);
    expect(calls.stop).toHaveLength(1);
    expect(getApiTestMocks().ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      null,
    );
    const secret = await stripeTokenSecret(userId, orgId);
    expect(secret).not.toBeNull();
    expect(secret?.description).toBe("Stripe CLI test mode API key");
  });

  it("driver loop exits when the abort signal fires before completion", async () => {
    const { userId, orgId } = await setupUser();
    const calls = mockStripeCliSandbox({ completeExitCode: 124 });

    const start = await accept(
      client().start({
        headers: { authorization: "Bearer clerk-session" },
        body: { mode: "test" },
      }),
      [200],
    );

    const driverController = new AbortController();
    const drivePromise = store.set(
      driveCliAuthStripeCompletion$,
      {
        orgId,
        userId,
        sessionToken: start.body.sessionToken,
      },
      driverController.signal,
    );

    // Let the first iteration's pending complete settle, then abort.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    driverController.abort();
    await expect(drivePromise).rejects.toMatchObject({ name: "AbortError" });

    expect(calls.stop).toHaveLength(0);
    const secret = await stripeTokenSecret(userId, orgId);
    expect(secret).toBeNull();
  });
});
