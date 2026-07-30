import { createHash, randomUUID } from "node:crypto";

import AdmZip from "adm-zip";
import { HttpResponse, http } from "msw";
import { beforeEach, expect } from "vitest";
import { zeroDeveloperSupportContract } from "@vm0/api-contracts/contracts/zero-developer-support";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const PLAIN_API_URL = "https://core-api.uk.plain.com/graphql/v1";

interface SupportSeed {
  readonly actor: ApiTestUser;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}

interface SupportRun {
  readonly runId: string;
  readonly sessionId: string;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly runId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: args.runId,
    capabilities: [],
    iat: seconds,
    exp: seconds + 60,
  });
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function putObjectInput(): Record<string, unknown> {
  const call = context.mocks.s3.send.mock.calls.find(([command]) => {
    const input = commandInput(command);
    return input.Body !== undefined && input.ContentType === "application/zip";
  });
  if (!call) {
    throw new Error("expected S3 PutObjectCommand");
  }
  return commandInput(call[0]);
}

function uploadedZip(): AdmZip {
  const body = putObjectInput().Body;
  if (!Buffer.isBuffer(body)) {
    throw new Error("expected ZIP upload body to be a Buffer");
  }
  return new AdmZip(body);
}

function zipText(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) {
    throw new Error(`expected ZIP entry ${name}`);
  }
  return entry.getData().toString("utf8");
}

function mockSessionHistoryBlob(hash: string, history: string): void {
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = (command as { readonly input?: { readonly Key?: string } })
      .input;
    if (input?.Key === `blobs/${hash}.blob`) {
      if (
        (command as { readonly constructor?: { readonly name?: string } })
          .constructor?.name === "HeadObjectCommand"
      ) {
        return Promise.resolve({
          ContentLength: Buffer.byteLength(history, "utf8"),
        });
      }
      return Promise.resolve({
        Body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(history, "utf8");
          },
        },
      });
    }
    return Promise.resolve({});
  });
}

async function seedSupportActor(): Promise<SupportSeed> {
  const bdd = createBddApi(context);
  const api = createRunsApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Support fixtures require an org-scoped actor");
  }
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Support Agent",
    visibility: "private",
  });
  return {
    actor,
    orgId: actor.orgId,
    userId: actor.userId,
    agentId: agent.agentId,
  };
}

async function createSupportRun(
  seed: SupportSeed,
  options: { readonly prompt?: string; readonly sessionId?: string } = {},
): Promise<SupportRun> {
  const api = createRunsApi(context);
  const prompt = options.prompt ?? "Support precondition";
  if (options.sessionId === undefined) {
    const run = await api.createRun(seed.actor, {
      agentId: seed.agentId,
      prompt,
      modelProvider: "anthropic-api-key",
    });
    return {
      runId: run.runId,
      sessionId: await api.readRunSessionId(seed.actor, run.runId),
    };
  }
  const run = await api.createDirectRun(seed.actor, {
    sessionId: options.sessionId,
    prompt,
  });
  return { runId: run.runId, sessionId: run.sessionId };
}

/**
 * Completes the run through the sandbox checkpoint + complete webhooks so its
 * result records the agent session (result.agentSessionId), matching runs
 * that finished a real session.
 */
async function completeRunWithSession(
  seed: SupportSeed,
  run: SupportRun,
): Promise<void> {
  const api = createRunsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const sandboxHeaders = {
    authorization: `Bearer ${api.sandboxTokenForRun(seed.actor, run.runId)}`,
  };
  const history = `support session history ${run.runId}`;
  const historyHash = createHash("sha256").update(history).digest("hex");
  mockSessionHistoryBlob(historyHash, history);
  await webhooks.requestAgentCheckpoint(
    {
      runId: run.runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: `support-cli-${run.runId}`,
      cliAgentSessionHistoryHash: historyHash,
    },
    sandboxHeaders,
    [200],
  );
  await webhooks.requestAgentComplete(
    { runId: run.runId, exitCode: 0, lastEventSequence: 0 },
    sandboxHeaders,
    [200],
  );
}

function client() {
  return setupApp({ context })(zeroDeveloperSupportContract);
}

function submitDeveloperSupport(
  token: string | undefined,
  body: {
    readonly title: string;
    readonly description: string;
    readonly consentCode?: string;
  },
) {
  return client().submit({
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
  });
}

function requireConsentCode(body: {
  readonly consentCode?: string;
  readonly reference?: string;
}): string {
  if (!body.consentCode) {
    throw new Error("expected consentCode response");
  }
  return body.consentCode;
}

function requireReference(body: {
  readonly consentCode?: string;
  readonly reference?: string;
}): string {
  if (!body.reference) {
    throw new Error("expected reference response");
  }
  return body.reference;
}

beforeEach(() => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
  });
  context.mocks.axiom.query.mockResolvedValue([]);
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.com/developer-support.zip?sig=test",
  );
  mockOptionalEnv("PLAIN_API_KEY", undefined);
});

describe("POST /api/zero/developer-support", () => {
  it("returns 401 when unauthenticated", async () => {
    const response = await accept(
      submitDeveloperSupport(undefined, {
        title: "Bug",
        description: "Something broke",
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for auth without run scope", async () => {
    const token = zeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: randomUUID(),
    });

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "This endpoint requires a zero token with runId and orgId",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns RUN_NOT_FOUND for a missing run", async () => {
    const seed = await seedSupportActor();
    await createSupportRun(seed);
    const token = zeroToken({
      userId: seed.userId,
      orgId: seed.orgId,
      runId: randomUUID(),
    });

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("RUN_NOT_FOUND");
  });

  it("returns a deterministic consent code when consentCode is omitted", async () => {
    const seed = await seedSupportActor();
    const run = await createSupportRun(seed);
    const token = zeroToken({ ...seed, runId: run.runId });

    const first = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    const second = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    expect(requireConsentCode(first.body)).toMatch(/^[0-9A-F]{4}$/);
    expect(second.body).toStrictEqual(first.body);
  });

  it("uses the same consent code across runs in the same session", async () => {
    const seed = await seedSupportActor();
    const base = await createSupportRun(seed);
    const first = await createSupportRun(seed, { sessionId: base.sessionId });
    const second = await createSupportRun(seed, { sessionId: base.sessionId });

    const firstResponse = await accept(
      submitDeveloperSupport(zeroToken({ ...seed, runId: first.runId }), {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    const secondResponse = await accept(
      submitDeveloperSupport(zeroToken({ ...seed, runId: second.runId }), {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    expect(secondResponse.body).toStrictEqual(firstResponse.body);
  });

  it("accepts a consent code from a different run in the same session", async () => {
    const seed = await seedSupportActor();
    const base = await createSupportRun(seed);
    const first = await createSupportRun(seed, { sessionId: base.sessionId });
    const second = await createSupportRun(seed, { sessionId: base.sessionId });

    const consent = await accept(
      submitDeveloperSupport(zeroToken({ ...seed, runId: first.runId }), {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    const response = await accept(
      submitDeveloperSupport(zeroToken({ ...seed, runId: second.runId }), {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
  });

  it("returns INVALID_CONSENT_CODE for an invalid code", async () => {
    const seed = await seedSupportActor();
    const run = await createSupportRun(seed);
    const response = await accept(
      submitDeveloperSupport(zeroToken({ ...seed, runId: run.runId }), {
        title: "Bug",
        description: "Something broke",
        consentCode: "ZZZZ",
      }),
      [400],
    );

    expect(response.body.error.code).toBe("INVALID_CONSENT_CODE");
  });

  it("submits a diagnostic bundle with a valid consent code", async () => {
    const seed = await seedSupportActor();
    const run = await createSupportRun(seed);
    const token = zeroToken({ ...seed, runId: run.runId });
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
    const putInput = putObjectInput();
    expect(putInput.Key).toContain("developer-support/");
  });

  it("falls back to the current runId when a run has no session", async () => {
    const seed = await seedSupportActor();
    const run = await createSupportRun(seed);
    const token = zeroToken({ ...seed, runId: run.runId });
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
    const agentEventsQuery = context.mocks.axiom.query.mock.calls
      .map(([apl]) => {
        return String(apl);
      })
      .find((apl) => {
        return apl.includes("agent-run-events") && apl.includes("runId in");
      });
    expect(agentEventsQuery).toContain(run.runId);
  });

  it("includes the user prompt in chat-history.jsonl", async () => {
    const seed = await seedSupportActor();
    const run = await createSupportRun(seed, {
      prompt: "Inspect the deployment",
    });
    const token = zeroToken({ ...seed, runId: run.runId });
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );

    await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    const lines = zipText(uploadedZip(), "chat-history.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line) as {
          readonly eventType: string;
          readonly eventData: {
            readonly role?: string;
            readonly content?: string;
          };
          readonly sequenceNumber: number;
        };
      });
    const promptEvent = lines.find((event) => {
      return event.eventType === "user_prompt";
    });

    expect(promptEvent?.eventData.role).toBe("user");
    expect(promptEvent?.eventData.content).toBe("Inspect the deployment");
    expect(promptEvent?.sequenceNumber).toBe(-1);
  });

  it("collects prompts from all runs in a multi-run session", async () => {
    const seed = await seedSupportActor();
    const first = await createSupportRun(seed, { prompt: "First prompt" });
    await completeRunWithSession(seed, first);
    const second = await createSupportRun(seed, {
      prompt: "Second prompt",
      sessionId: first.sessionId,
    });
    const token = zeroToken({ ...seed, runId: second.runId });
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Session bug",
        description: "Something broke",
      }),
      [200],
    );

    await accept(
      submitDeveloperSupport(token, {
        title: "Session bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    const lines = zipText(uploadedZip(), "chat-history.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return JSON.parse(line) as {
          readonly runId: string;
          readonly eventType: string;
          readonly eventData: { readonly content?: string };
        };
      });
    const promptEvents = lines.filter((event) => {
      return event.eventType === "user_prompt";
    });

    expect(
      promptEvents.map((event) => {
        return event.eventData.content;
      }),
    ).toStrictEqual(["First prompt", "Second prompt"]);
    expect(promptEvents[0]?.runId).toBe(first.runId);
    expect(promptEvents[1]?.runId).toBe(second.runId);
  });

  it("succeeds when optional Axiom log queries fail", async () => {
    const seed = await seedSupportActor();
    const run = await createSupportRun(seed);
    const token = zeroToken({ ...seed, runId: run.runId });
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
      }),
      [200],
    );
    context.mocks.axiom.query.mockRejectedValue(new Error("Axiom down"));

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Bug",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
  });

  it("creates a Plain support thread when PLAIN_API_KEY is configured", async () => {
    mockOptionalEnv("PLAIN_API_KEY", "plainkey_test_abc");
    let plainCallCount = 0;
    server.use(
      http.post(PLAIN_API_URL, () => {
        plainCallCount++;
        if (plainCallCount === 1) {
          return HttpResponse.json({
            data: {
              upsertTenant: {
                tenant: { id: "t1", externalId: "o1", name: "Org" },
                error: null,
              },
            },
          });
        }
        if (plainCallCount === 2) {
          return HttpResponse.json({
            data: {
              upsertCustomer: {
                customer: { id: "c1", externalId: "u1" },
                result: "CREATED",
                error: null,
              },
            },
          });
        }
        if (plainCallCount === 3) {
          return HttpResponse.json({
            data: {
              createThread: {
                thread: { id: "th1", externalId: "ds-ref1" },
                error: null,
              },
            },
          });
        }
        return HttpResponse.json({
          data: {
            createThreadEvent: { threadEvent: { id: "ev1" }, error: null },
          },
        });
      }),
    );
    const seed = await seedSupportActor();
    const run = await createSupportRun(seed);
    const token = zeroToken({ ...seed, runId: run.runId });
    const consent = await accept(
      submitDeveloperSupport(token, {
        title: "Plain route test",
        description: "Something broke",
      }),
      [200],
    );

    const response = await accept(
      submitDeveloperSupport(token, {
        title: "Plain route test",
        description: "Something broke",
        consentCode: requireConsentCode(consent.body),
      }),
      [200],
    );

    expect(requireReference(response.body)).toMatch(/^ds-[a-f0-9]{8}$/);
    expect(plainCallCount).toBe(4);
  });
});
